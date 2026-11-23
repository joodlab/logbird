using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Soak;

/// <summary>
/// The .NET SDK soak harness: sustained load from several threads, with injected failures and periodic client restarts,
/// then exact accounting of every event and checks that resources stayed bounded. See README.md next to this file.
/// </summary>
internal static class Program
{
    /// <summary>Drop reasons the documentation lists (docs/sdk-dotnet.md and sdks/dotnet/README.md).</summary>
    internal static readonly HashSet<DropReason> Documented =
    [
        DropReason.QueueFull, DropReason.Rejected, DropReason.HttpError, DropReason.TooLarge, DropReason.Shutdown,
        DropReason.Invalid, DropReason.InvalidEntityId, DropReason.Unacknowledged,
    ];

    /// <summary>Drops the documentation calls "not confirmed": the server may already have stored the event.</summary>
    internal static readonly HashSet<DropReason> Unconfirmed = [DropReason.HttpError, DropReason.Unacknowledged, DropReason.Shutdown];

    private static async Task<int> Main(string[] args)
    {
        SoakOptions options;
        try
        {
            options = SoakOptions.Parse(args);
        }
        catch (ArgumentException e)
        {
            Console.Error.WriteLine(e.Message);
            Console.Error.WriteLine(SoakOptions.Usage);
            return 2;
        }

        Directory.CreateDirectory(options.ReportDirectory);
        var reportPath = Path.Combine(options.ReportDirectory, "report.json");

        // A watchdog independent of everything the run awaits: if the run has not finished well after its duration (a
        // hung flush, disposal or read-back), it still leaves a failing report and exits red before the CI job times out.
        var watchdog = new Timer(_ =>
        {
            File.WriteAllText(reportPath, new JsonObject
            {
                ["checks"] = new JsonArray(new JsonObject { ["name"] = "the run finished", ["passed"] = false, ["detail"] = "still running 15 minutes after its duration; see metrics.csv" }),
            }.ToJsonString());
            Console.Error.WriteLine("soak: FAILED: the run did not finish 15 minutes after its duration");
            Environment.Exit(1);
        }, null, options.Duration + TimeSpan.FromMinutes(15), Timeout.InfiniteTimeSpan);

        JsonObject report;
        try
        {
            using var run = new SoakRun(options);
            report = await run.ExecuteAsync().ConfigureAwait(false);
        }
        catch (Exception e)
        {
            // An unexpected exception still leaves a failing report (the type and message only; no keys are in either).
            report = new JsonObject
            {
                ["checks"] = new JsonArray(new JsonObject { ["name"] = "the run completed", ["passed"] = false, ["detail"] = e.GetType().Name + ": " + e.Message }),
            };
        }

        watchdog.Dispose();
        File.WriteAllText(reportPath, report.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        var failed = report["checks"]!.AsArray().Where(c => !c!["passed"]!.GetValue<bool>()).Select(c => c!["name"]!.GetValue<string>()).ToArray();
        Console.WriteLine(failed.Length == 0 ? "soak: every check passed" : "soak: FAILED: " + string.Join(", ", failed));
        return failed.Length == 0 ? 0 : 1;
    }

    internal static string Runtime() => System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription.Trim() + " on " + System.Runtime.InteropServices.RuntimeInformation.OSDescription.Trim();

    internal static JsonObject Check(string name, bool passed, string detail)
    {
        Console.WriteLine((passed ? "  ok   " : "  FAIL ") + name + ": " + detail);
        return new JsonObject { ["name"] = name, ["passed"] = passed, ["detail"] = detail };
    }

    internal static async Task<T?> WithinAsync<T>(Task<T> task, TimeSpan limit)
        where T : struct
        => await Task.WhenAny(task, Task.Delay(limit)).ConfigureAwait(false) == task ? await task.ConfigureAwait(false) : null;
}

internal sealed class SoakRun(SoakOptions options) : IDisposable
{
    /// <summary>The SDK's batch size, which the harness leaves at its default.</summary>
    private static readonly int BatchSize = new LogbirdOptions().BatchSize;

    private readonly LongMap _tracked = new(options.ExpectedEvents);
    private readonly LongMap _dropped = new(options.ExpectedEvents);
    // Clients whose disposal has begun. Weak, so a retired client is never kept alive by its mark.
    private readonly System.Runtime.CompilerServices.ConditionalWeakTable<LogbirdClient, object> _retiring = new();
    private readonly ConcurrentDictionary<DropReason, long> _dropReasons = new();
    private readonly ConcurrentDictionary<string, long> _errors = new(StringComparer.Ordinal);
    private readonly LatencyHistogram _trackLatency = new();
    private readonly List<ResourceSample> _samples = [];
    private readonly List<double> _flushSeconds = [];
    private readonly List<LogbirdClient> _clients = [];

    // Producers hold the read lock around Track; a restart swaps the client under the write lock, so once the swap returns
    // no Track can still be running on the old client and its counters are final when it is retired.
    private readonly ReaderWriterLockSlim _swap = new(LockRecursionPolicy.NoRecursion);
    private long _retiredDelivered;
    private long _retiredRejected;
    private long _retiredDropped;
    private int _clientCount;
    private readonly string _runId = Guid.NewGuid().ToString("N").Substring(0, 12);
    private long _doubleDrops;
    private long _droppedWithoutId;
    private long _trackThrew;
    private long _flushesFalse;
    private long _flushesHung;
    private long _shutdownsHung;
    private long _restarts;
    private long _queueHighWater;
    private long _sent;
    private LogbirdClient? _client;
    private double _loadSeconds;

    public void Dispose() => _swap.Dispose();

    public async Task<JsonObject> ExecuteAsync()
    {
        var weights = options.Faults;
        using var samples = new Samples(weights, "stand-in", Path.Combine(options.ReportDirectory, "stand-in-samples.jsonl"));
        using var standIn = new StandIn(weights, options.Seed, options.RequestTimeout + TimeSpan.FromSeconds(3), options.IngestKey, samples, options.ExpectedEvents);
        standIn.Start();
        Console.WriteLine($"soak {_runId}: {options.Duration} at {options.Rate} events/s on {Program.Runtime()}, stand-in at {standIn.Endpoint}");

        var clock = Stopwatch.StartNew();
        using var stop = new CancellationTokenSource(options.Duration);
        _client = NewClient(standIn.Endpoint);
        using var csv = new StreamWriter(Path.Combine(options.ReportDirectory, "metrics.csv"));
        csv.WriteLine("seconds,tracked,delivered,rejected,dropped,queue,heap_mb,working_set_mb,handles,threads,restarts");

        var producers = Enumerable.Range(0, options.Producers).Select(p => Task.Run(() => ProduceAsync(p, clock, stop.Token))).ToArray();
        var background = new[]
        {
            Task.Run(() => SampleAsync(csv, clock, stop.Token)),
            Task.Run(() => RestartAsync(standIn.Endpoint, stop.Token)),
            Task.Run(() => FlushAsync(stop.Token)),
            Task.Run(() => QueuePollAsync(stop.Token)),
        };
        await Task.WhenAll(producers).ConfigureAwait(false);
        _loadSeconds = clock.Elapsed.TotalSeconds;
        await Task.WhenAll(background).ConfigureAwait(false);

        // Drain: no more faults, then a final flush and shutdown must settle everything, each under its own watchdog.
        standIn.Healthy = true;
        var final = Volatile.Read(ref _client)!;
        var drain = Stopwatch.StartNew();
        var drained = await Program.WithinAsync(final.FlushAsync(), TimeSpan.FromMinutes(2)).ConfigureAwait(false) == true;
        var drainSeconds = drain.Elapsed.TotalSeconds;
        var disposing = final.DisposeAsync().AsTask();
        var disposed = await Task.WhenAny(disposing, Task.Delay(TimeSpan.FromMinutes(1))).ConfigureAwait(false) == disposing && !disposing.IsFaulted;
        if (disposed)
        {
            Retire(final);
        }
        var quiet = await standIn.QuiesceAsync(TimeSpan.FromMinutes(1)).ConfigureAwait(false);

        // Late OnDrop notifications run on the client's background thread; give them a moment.
        await Task.Delay(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
        WriteSample(csv, clock);

        return Report(standIn, standIn.Stored, drained, drainSeconds, disposed, quiet, clock.Elapsed);
    }

    private LogbirdClient NewClient(Uri endpoint)
    {
        var client = new LogbirdClient(new LogbirdOptions
        {
            Endpoint = endpoint,
            IngestKey = options.IngestKey,
            RequestTimeout = options.RequestTimeout,
            ShutdownTimeout = TimeSpan.FromSeconds(10),
            MaxQueueSize = options.MaxQueueSize,
            Environment = "soak",
            Source = "logbird-soak",
            OnDrop = OnDrop,
            OnError = e => _errors.AddOrUpdate(e.GetType().Name, 1, (_, n) => n + 1),
        });
        lock (_clients)
        {
            _clients.Add(client);
            _clientCount++;
        }

        return client;
    }

    private void OnDrop(DroppedEvent drop)
    {
        _dropReasons.AddOrUpdate(drop.Reason, 1, (_, n) => n + 1);
        if (string.IsNullOrEmpty(drop.Id))
        {
            Interlocked.Increment(ref _droppedWithoutId);
            return;
        }

        if (!_dropped.TryAdd(LongMap.Hash(drop.Id!), (long)drop.Reason))
        {
            Interlocked.Increment(ref _doubleDrops);
        }
    }

    private async Task ProduceAsync(int producer, Stopwatch clock, CancellationToken stop)
    {
        // One shared budget paced against elapsed time: producers claim events from it, so the total holds the requested
        // rate at any setting, even below one event per producer per second.
        var actions = new[] { "booking.created", "booking.cancelled", "invoice.paid", "user.signed_in", "settings.updated" };
        var total = (long)(options.Rate * options.Duration.TotalSeconds);
        while (!stop.IsCancellationRequested)
        {
            // Never more than the nominal total (rate x duration), however the last tick falls.
            var due = Math.Min(total, (long)(clock.Elapsed.TotalSeconds * options.Rate));
            while (true)
            {
                var claimed = Interlocked.Read(ref _sent);
                if (claimed >= due || Interlocked.CompareExchange(ref _sent, claimed + 1, claimed) != claimed)
                {
                    if (claimed >= due)
                    {
                        break;
                    }

                    continue;
                }

                var id = LogbirdClient.NewEventId();
                _tracked.TryAdd(LongMap.Hash(id), 0);
                var n = claimed;
                var e = new AuditEvent(actions[n % actions.Length])
                {
                    Id = id,
                    Actor = AuditActor.User("soak_user_" + (n % 97), "Soak User", "soak." + (n % 97) + "@example.invalid"),
                    Tenant = new AuditTenant("soak_tenant_" + (n % 7)),
                }
                .Target("record", "soak_" + producer + "_" + n)
                .WithMetadata("soakRun", _runId);
                _swap.EnterReadLock();
                try
                {
                    var client = _client!;
                    var started = Stopwatch.GetTimestamp();
                    try
                    {
                        client.Track(e);
                    }
                    catch (Exception)
                    {
                        Interlocked.Increment(ref _trackThrew);
                    }

                    _trackLatency.Add(Stopwatch.GetTimestamp() - started);
                }
                finally
                {
                    _swap.ExitReadLock();
                }
            }

            try
            {
                await Task.Delay(10, stop).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task RestartAsync(Uri endpoint, CancellationToken stop)
    {
        while (true)
        {
            try
            {
                await Task.Delay(options.RestartEvery, stop).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            // Swap first, then dispose the old client while producers already write to the new one. A flush of the old
            // client may return false only once its disposal has begun.
            var replacement = NewClient(endpoint);
            LogbirdClient old;
            _swap.EnterWriteLock();
            try
            {
                old = _client!;
                Volatile.Write(ref _client, replacement);
            }
            finally
            {
                _swap.ExitWriteLock();
            }

            _retiring.GetValue(old, _ => new object());
            var disposing = old.DisposeAsync().AsTask();
            if (await Task.WhenAny(disposing, Task.Delay(TimeSpan.FromMinutes(1))).ConfigureAwait(false) != disposing || disposing.IsFaulted)
            {
                Interlocked.Increment(ref _shutdownsHung);
            }
            else
            {
                Retire(old);
            }

            Interlocked.Increment(ref _restarts);
        }
    }

    private async Task FlushAsync(CancellationToken stop)
    {
        // A flush settles what was queued before it; under faults that can take a batch's full retry budget (five
        // minutes), so a flush fails only when it reports false or passes that budget plus slack. The watchdog does not
        // rely on the flush honouring its token.
        var limit = TimeSpan.FromMinutes(6);
        while (true)
        {
            try
            {
                await Task.Delay(options.FlushEvery, stop).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            var client = Volatile.Read(ref _client)!;
            var watch = Stopwatch.StartNew();
            using var timeout = new CancellationTokenSource(limit);
            Task<bool> flush;
            try
            {
                flush = client.FlushAsync(timeout.Token);
            }
            catch (ObjectDisposedException)
            {
                continue;
            }

            var result = await Program.WithinAsync(SafeFlush(flush), limit + TimeSpan.FromSeconds(30)).ConfigureAwait(false);

            // False is a failure unless a restart had already begun disposing this client (its shutdown then settles and
            // reports the rest).
            if (result is null)
            {
                Interlocked.Increment(ref _flushesHung);
            }
            else if (result == false && !_retiring.TryGetValue(client, out _))
            {
                Interlocked.Increment(ref _flushesFalse);
            }

            lock (_flushSeconds)
            {
                _flushSeconds.Add(watch.Elapsed.TotalSeconds);
            }
        }
    }

    private static async Task<bool> SafeFlush(Task<bool> flush)
    {
        try
        {
            return await flush.ConfigureAwait(false);
        }
        catch (Exception e) when (e is OperationCanceledException or ObjectDisposedException)
        {
            return false;
        }
    }

    private async Task QueuePollAsync(CancellationToken stop)
    {
        // A queue high-water mark between the 5-second samples.
        while (!stop.IsCancellationRequested)
        {
            long length = Volatile.Read(ref _client)!.Stats.QueueLength;
            long seen;
            while (length > (seen = Interlocked.Read(ref _queueHighWater)) && Interlocked.CompareExchange(ref _queueHighWater, length, seen) != seen)
            {
            }

            try
            {
                await Task.Delay(50, stop).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task SampleAsync(StreamWriter csv, Stopwatch clock, CancellationToken stop)
    {
        while (true)
        {
            WriteSample(csv, clock);
            try
            {
                await Task.Delay(options.SampleEvery, stop).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>
    /// Counters summed over every client the run created, each exactly once: live clients (active or retiring) by their
    /// current counters, disposed ones by the final counters recorded when they were released.
    /// </summary>
    private (long Delivered, long Rejected, long Dropped) Totals()
    {
        lock (_clients)
        {
            return (
                _retiredDelivered + _clients.Sum(c => c.Stats.Delivered),
                _retiredRejected + _clients.Sum(c => c.Stats.Rejected),
                _retiredDropped + _clients.Sum(c => c.Stats.Dropped));
        }
    }

    /// <summary>Records a disposed client's final counters and releases it, so retired clients hold no memory.</summary>
    private void Retire(LogbirdClient client)
    {
        var stats = client.Stats;
        lock (_clients)
        {
            if (_clients.Remove(client))
            {
                _retiredDelivered += stats.Delivered;
                _retiredRejected += stats.Rejected;
                _retiredDropped += stats.Dropped;
            }
        }

    }

    private void WriteSample(StreamWriter csv, Stopwatch clock)
    {
        using var process = Process.GetCurrentProcess();
        var current = Volatile.Read(ref _client)!;
        var queue = current.Stats.QueueLength;
        var totals = Totals();
        var sample = new ResourceSample(clock.Elapsed.TotalSeconds, GC.GetTotalMemory(forceFullCollection: true), process.WorkingSet64, process.HandleCount, process.Threads.Count, queue);
        lock (_samples)
        {
            _samples.Add(sample);
            csv.WriteLine(string.Join(",",
                sample.Seconds.ToString("F0", CultureInfo.InvariantCulture),
                _tracked.Count, totals.Delivered, totals.Rejected, totals.Dropped, queue,
                (sample.Heap / 1048576.0).ToString("F1", CultureInfo.InvariantCulture),
                (sample.WorkingSet / 1048576.0).ToString("F1", CultureInfo.InvariantCulture),
                sample.Handles, sample.Threads, Interlocked.Read(ref _restarts)));
            csv.Flush();
        }
    }

    private int Growths(StandIn standIn) => _tracked.Growths + _dropped.Growths + standIn.Stored.Growths + standIn.Acknowledged.Growths + standIn.FirstSeen.Growths;

    private JsonObject Report(StandIn standIn, LongMap stored, bool drained, double drainSeconds, bool disposed, bool quiet, TimeSpan elapsed)
    {
        var tracked = _tracked.Entries().Select(e => e.Key).ToArray();
        var dropped = _dropped.Entries().ToDictionary(e => e.Key, e => (DropReason)e.Value);
        var trackedSet = new HashSet<long>(tracked);
        var storedKeys = stored.Entries().Select(e => e.Key).ToArray();
        var lost = tracked.Count(id => !stored.Contains(id) && !dropped.ContainsKey(id));
        var dropsNotTracked = dropped.Keys.Count(id => !trackedSet.Contains(id));
        var both = dropped.Where(d => stored.Contains(d.Key)).ToList();
        var bothConfirmed = both.Count(d => !Program.Unconfirmed.Contains(d.Value));
        var strangers = storedKeys.Count(id => !trackedSet.Contains(id));
        var acknowledgedNotDropped = standIn.Acknowledged.Entries().Count(e => trackedSet.Contains(e.Key) && !dropped.ContainsKey(e.Key));
        var totals = Totals();
        var undocumented = _dropReasons.Keys.Where(r => !Program.Documented.Contains(r)).ToArray();
        var unexpected = _dropReasons.Keys.Where(r => r is DropReason.TooLarge or DropReason.Invalid or DropReason.InvalidEntityId).ToArray();
        var achieved = _loadSeconds > 0 ? tracked.Length / _loadSeconds : 0;

        ResourceSample[] samples;
        lock (_samples)
        {
            samples = [.. _samples];
        }

        var resources = ResourceReport.From(samples, _loadSeconds);
        var slow = _trackLatency.OverThreshold;
        var calls = _trackLatency.Count;
        var checks = new JsonArray();

        foreach (var c in new[]
        {
            Program.Check("every tracked event is stored or reported dropped", lost == 0, $"{lost} of {tracked.Length} neither stored nor reported"),
            Program.Check("no event is reported dropped twice", Interlocked.Read(ref _doubleDrops) == 0 && Interlocked.Read(ref _droppedWithoutId) == 0, $"{_doubleDrops} repeated, {_droppedWithoutId} without an id"),
            Program.Check("every drop report names a tracked event", dropsNotTracked == 0, $"{dropsNotTracked} drop reports for ids never tracked"),
            Program.Check("an event both stored and dropped has an unconfirmed reason", bothConfirmed == 0, $"{both.Count} stored and dropped, {bothConfirmed} with a confirmed reason"),
            Program.Check("nothing is stored that was not tracked", strangers == 0, $"{strangers} unknown ids stored"),
            Program.Check("no event changed content on retry", standIn.Conflicts == 0, $"{standIn.Conflicts} arrivals differed from the id's first arrival"),
            Program.Check("every reported drop reason is documented", undocumented.Length == 0 && unexpected.Length == 0, "reasons: " + string.Join(", ", _dropReasons.OrderBy(r => r.Key).Select(r => r.Key + "=" + r.Value))),
            Program.Check("Stats.Delivered matches the ids acknowledged to the client", totals.Delivered == acknowledgedNotDropped, $"Delivered {totals.Delivered}, acknowledged and not dropped {acknowledgedNotDropped}"),
            Program.Check("Stats.Rejected + Dropped matches the drop reports", totals.Rejected + totals.Dropped == dropped.Count + Interlocked.Read(ref _droppedWithoutId), $"Rejected + Dropped {totals.Rejected + totals.Dropped}, reports {dropped.Count + _droppedWithoutId}"),
            Program.Check("Track never threw", Interlocked.Read(ref _trackThrew) == 0, $"{_trackThrew} throws"),
            Program.Check("no flush or shutdown failed or hung", Interlocked.Read(ref _flushesFalse) + Interlocked.Read(ref _flushesHung) + Interlocked.Read(ref _shutdownsHung) == 0, $"{_flushesFalse} flushes returned false before their client's shutdown began, {_flushesHung} passed 6.5 minutes, {_shutdownsHung} shutdowns passed 1 minute"),
            Program.Check("the final drain settled everything", drained && disposed && quiet, $"final flush {(drained ? "completed" : "did not complete")} in {drainSeconds:F1} s, shutdown {(disposed ? "completed" : "hung")}, stand-in {(quiet ? "idle" : "still busy")}"),
            Program.Check("at most 1% of Track calls took over 5 ms", calls > 0 && slow * 100 <= calls, $"{slow} of {calls} over 5 ms; p50 {_trackLatency.Percentile(0.5)}, p99 {_trackLatency.Percentile(0.99)}, max {_trackLatency.Max:F3} ms"),
            Program.Check("the requested rate was held", achieved >= options.Rate * 0.9, $"achieved {achieved:F0} of {options.Rate} events/s"),
            // MaxQueueSize bounds the events waiting to be sent; Stats.QueueLength also counts the batch being sent.
            Program.Check("the queue stayed within MaxQueueSize plus the batch in flight", Interlocked.Read(ref _queueHighWater) <= options.MaxQueueSize + BatchSize, $"high-water mark {_queueHighWater} (polled every 50 ms), bound {options.MaxQueueSize} waiting + {BatchSize} in flight"),
            Program.Check("the bookkeeping tables never grew during the run", Growths(standIn) == 0, $"{Growths(standIn)} growths (each would allocate inside the heap measurement)"),
            Program.Check("enough samples to judge resources", resources.Valid, resources.ValidDetail),
            Program.Check("heap stayed bounded", resources.Valid && resources.HeapBounded, resources.HeapDetail),
            Program.Check("handle count stayed bounded", resources.Valid && resources.HandlesBounded, resources.HandlesDetail),
            Program.Check("thread count stayed bounded", resources.Valid && resources.ThreadsBounded, resources.ThreadsDetail),
        })
        {
            checks.Add(c);
        }

        var faults = new JsonObject();
        foreach (var f in standIn.Faults.OrderBy(f => f.Key))
        {
            faults[f.Key.ToString()] = f.Value;
        }

        var reasons = new JsonObject();
        foreach (var r in _dropReasons.OrderBy(r => r.Key))
        {
            reasons[r.Key.ToString()] = r.Value;
        }

        var errors = new JsonObject();
        foreach (var e in _errors.OrderBy(e => e.Key, StringComparer.Ordinal))
        {
            errors[e.Key] = e.Value;
        }

        return new JsonObject
        {
            ["run"] = _runId,
            ["runtime"] = Program.Runtime(),
            ["mode"] = "stand-in",
            ["config"] = options.ToJson(),
            ["elapsedSeconds"] = Math.Round(elapsed.TotalSeconds),
            ["achievedRate"] = Math.Round(achieved, 1),
            ["totals"] = new JsonObject
            {
                ["tracked"] = tracked.Length,
                ["stored"] = storedKeys.Length,
                ["acknowledged"] = standIn.Acknowledged.Count,
                ["delivered"] = totals.Delivered,
                ["rejected"] = totals.Rejected,
                ["dropped"] = totals.Dropped,
                ["dropReports"] = dropped.Count,
                ["storedAndDropped"] = both.Count,
                ["clients"] = _clientCount,
                ["restarts"] = Interlocked.Read(ref _restarts),
                ["requests"] = standIn.Requests,
                ["connections"] = standIn.Connections,
                ["resendsAfterStore"] = standIn.Resends,
                ["bookkeepingTableGrowths"] = Growths(standIn),
            },
            ["faults"] = faults,
            ["dropReasons"] = reasons,
            ["errorsReported"] = errors,
            ["trackLatencyMs"] = new JsonObject
            {
                ["p50"] = _trackLatency.Percentile(0.5),
                ["p99"] = _trackLatency.Percentile(0.99),
                ["p999"] = _trackLatency.Percentile(0.999),
                ["max"] = Math.Round(_trackLatency.Max, 3),
                ["over5ms"] = slow,
            },
            ["flushSeconds"] = new JsonObject
            {
                ["count"] = _flushSeconds.Count,
                ["max"] = _flushSeconds.Count == 0 ? 0 : Math.Round(_flushSeconds.Max(), 2),
            },
            ["resources"] = resources.ToJson(),
            ["checks"] = checks,
        };
    }
}

internal sealed record ResourceSample(double Seconds, long Heap, long WorkingSet, int Handles, int Threads, int Queue);

/// <summary>
/// Resource bounds: the last third of the load against a baseline, the median of the samples taken between 10% and 25% of
/// the load (after warm-up). The heap is measured after a full collection; the harness's own per-event bookkeeping lives
/// in tables allocated before the baseline, so the heap may grow only by 32 MB of slack. A run needs at least 10 samples
/// over at least 60 seconds of load to be judged.
/// </summary>
internal sealed record ResourceReport(bool Valid, string ValidDetail, bool HeapBounded, string HeapDetail, bool HandlesBounded, string HandlesDetail, bool ThreadsBounded, string ThreadsDetail, int Samples, long PeakWorkingSet)
{
    public static ResourceReport From(ResourceSample[] all, double loadSeconds)
    {
        var load = all.Where(s => s.Seconds <= loadSeconds + 1).ToArray();
        var valid = load.Length >= 10 && loadSeconds >= 60;
        var validDetail = $"{load.Length} samples over {loadSeconds:F0} s of load";
        var window = load.Where(s => s.Seconds >= loadSeconds * 0.10 && s.Seconds <= loadSeconds * 0.25).ToArray();
        if (!valid || window.Length == 0)
        {
            return new ResourceReport(false, validDetail + " (need 10 over 60 s)", false, "not judged", false, "not judged", false, "not judged", all.Length, all.Length == 0 ? 0 : all.Max(s => s.WorkingSet));
        }

        var late = load.Where(s => s.Seconds >= loadSeconds * 2 / 3).ToArray();
        if (late.Length == 0)
        {
            return new ResourceReport(false, validDetail + " (none in the last third of the load)", false, "not judged", false, "not judged", false, "not judged", all.Length, all.Max(s => s.WorkingSet));
        }

        long Median(Func<ResourceSample, long> pick) => window.Select(pick).OrderBy(v => v).ElementAt(window.Length / 2);
        var heapBase = Median(s => s.Heap);
        var handleBase = Median(s => s.Handles);
        var threadBase = Median(s => s.Threads);
        var heapLimit = heapBase + (32L << 20);
        var handleLimit = (handleBase * 3 / 2) + 100;
        var threadLimit = threadBase + 50;
        var heapMax = late.Max(s => s.Heap);
        var handleMax = late.Max(s => s.Handles);
        var threadMax = late.Max(s => s.Threads);
        return new ResourceReport(
            true, validDetail,
            heapMax <= heapLimit, $"baseline {heapBase / 1048576.0:F1} MB, late max {heapMax / 1048576.0:F1} MB, limit {heapLimit / 1048576.0:F1} MB",
            handleMax <= handleLimit, $"baseline {handleBase}, late max {handleMax}, limit {handleLimit}",
            threadMax <= threadLimit, $"baseline {threadBase}, late max {threadMax}, limit {threadLimit}",
            all.Length, all.Max(s => s.WorkingSet));
    }

    public JsonObject ToJson() => new()
    {
        ["samples"] = ValidDetail,
        ["heap"] = HeapDetail,
        ["handles"] = HandlesDetail,
        ["threads"] = ThreadsDetail,
        ["peakWorkingSetMb"] = PeakWorkingSet >> 20,
    };
}

/// <summary>
/// Track durations: an exact count of calls over 5 ms (the checked threshold) and a histogram for the reported
/// percentiles (1 microsecond buckets to 1 ms, 100 microsecond buckets to 100 ms; above that only a lower bound).
/// Recording never allocates.
/// </summary>
internal sealed class LatencyHistogram
{
    private static readonly long FiveMs = Stopwatch.Frequency / 200;
    private readonly long[] _fine = new long[1000];
    private readonly long[] _coarse = new long[990];
    private long _overflow;
    private long _count;
    private long _over;
    private long _maxTicks;

    public long Count => Interlocked.Read(ref _count);

    public long OverThreshold => Interlocked.Read(ref _over);

    public double Max => Interlocked.Read(ref _maxTicks) * 1000.0 / Stopwatch.Frequency;

    public void Add(long ticks)
    {
        if (ticks > FiveMs)
        {
            Interlocked.Increment(ref _over);
        }

        var micros = ticks * 1_000_000 / Stopwatch.Frequency;
        if (micros < 1000)
        {
            Interlocked.Increment(ref _fine[micros]);
        }
        else if (micros < 100_000)
        {
            Interlocked.Increment(ref _coarse[(micros - 1000) / 100]);
        }
        else
        {
            Interlocked.Increment(ref _overflow);
        }

        Interlocked.Increment(ref _count);
        long seen;
        while (ticks > (seen = Interlocked.Read(ref _maxTicks)) && Interlocked.CompareExchange(ref _maxTicks, ticks, seen) != seen)
        {
        }
    }

    /// <summary>The percentile as text in milliseconds: a bucket's upper bound, or "over 100 ms" beyond the histogram.</summary>
    public string Percentile(double p)
    {
        var target = (long)Math.Ceiling(Count * p);
        long seen = 0;
        for (var i = 0; i < _fine.Length; i++)
        {
            seen += Interlocked.Read(ref _fine[i]);
            if (seen >= target)
            {
                return ((i + 1) / 1000.0).ToString("F3", CultureInfo.InvariantCulture) + " ms";
            }
        }

        for (var i = 0; i < _coarse.Length; i++)
        {
            seen += Interlocked.Read(ref _coarse[i]);
            if (seen >= target)
            {
                return ((1000 + ((i + 1) * 100)) / 1000.0).ToString("F1", CultureInfo.InvariantCulture) + " ms";
            }
        }

        return "over 100 ms";
    }
}
