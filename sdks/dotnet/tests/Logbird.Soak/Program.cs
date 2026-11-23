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
    /// <summary>Drop reasons the documentation lists (docs/sdk-dotnet.md and sdks/dotnet/README.md), by the DropReason name.</summary>
    private static readonly HashSet<DropReason> Documented =
    [
        DropReason.QueueFull, DropReason.Rejected, DropReason.HttpError, DropReason.TooLarge, DropReason.Shutdown,
        DropReason.Invalid, DropReason.InvalidEntityId, DropReason.Unacknowledged,
    ];

    /// <summary>Drops the documentation calls "not confirmed": the server may already have stored the event.</summary>
    private static readonly HashSet<DropReason> Unconfirmed = [DropReason.HttpError, DropReason.Unacknowledged, DropReason.Shutdown];

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
        var run = new SoakRun(options);
        var report = await run.ExecuteAsync().ConfigureAwait(false);
        File.WriteAllText(Path.Combine(options.ReportDirectory, "report.json"), report.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        var failed = report["checks"]!.AsArray().Where(c => !c!["passed"]!.GetValue<bool>()).Select(c => c!["name"]!.GetValue<string>()).ToArray();
        Console.WriteLine(failed.Length == 0 ? "soak: every check passed" : "soak: FAILED: " + string.Join(", ", failed));
        return failed.Length == 0 ? 0 : 1;
    }

    private sealed class SoakRun(SoakOptions options)
    {
        private readonly ConcurrentDictionary<Guid, byte> _tracked = new();
        private readonly ConcurrentDictionary<Guid, DropReason> _dropped = new();
        private readonly ConcurrentDictionary<DropReason, long> _dropReasons = new();
        private readonly ConcurrentDictionary<string, long> _errors = new();
        private readonly LatencyHistogram _trackLatency = new();
        private readonly List<ResourceSample> _samples = [];
        private readonly List<double> _flushSeconds = [];
        private readonly List<LogbirdStats> _finishedStats = [];
        private readonly string _runId = Guid.NewGuid().ToString("N").Substring(0, 12);
        private long _doubleDrops;
        private long _droppedWithoutId;
        private long _trackThrew;
        private long _flushesStuck;
        private long _restarts;
        private LogbirdClient? _client;

        public async Task<JsonObject> ExecuteAsync()
        {
            var samples = new Samples();
            var weights = options.Upstream is null ? options.Faults : options.Faults.Where(f => f.Key != Fault.Reject).ToDictionary(f => f.Key, f => f.Value);
            using var standIn = new StandIn(weights, options.Seed, options.RequestTimeout + TimeSpan.FromSeconds(3), samples, options.Upstream);
            standIn.Start();
            Console.WriteLine($"soak {_runId}: {options.Duration} at {options.Rate} events/s on {Runtime()}, {(options.Upstream is null ? "stand-in" : "proxy to " + options.Upstream)} at {standIn.Endpoint}");

            var started = DateTimeOffset.UtcNow;
            var clock = Stopwatch.StartNew();
            using var stop = new CancellationTokenSource(options.Duration);
            _client = NewClient(standIn.Endpoint);
            using var csv = new StreamWriter(Path.Combine(options.ReportDirectory, "metrics.csv"));
            csv.WriteLine("seconds,tracked,delivered,rejected,dropped,queue,heap_mb,working_set_mb,handles,threads,restarts");

            var producers = Enumerable.Range(0, options.Producers).Select(p => Task.Run(() => ProduceAsync(p, stop.Token))).ToArray();
            var sampler = Task.Run(() => SampleAsync(csv, clock, stop.Token));
            var restarter = Task.Run(() => RestartAsync(standIn.Endpoint, stop.Token));
            var flusher = Task.Run(() => FlushAsync(stop.Token));
            await Task.WhenAll(producers).ConfigureAwait(false);
            await Task.WhenAll(sampler, restarter, flusher).ConfigureAwait(false);

            // Drain: no more faults, then a final flush and shutdown must settle everything.
            standIn.Healthy = true;
            var final = _client!;
            var drain = Stopwatch.StartNew();
            using var drainLimit = new CancellationTokenSource(TimeSpan.FromSeconds(120));
            bool drained;
            try
            {
                drained = await final.FlushAsync(drainLimit.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                drained = false;
            }

            var drainSeconds = drain.Elapsed.TotalSeconds;
            await final.DisposeAsync().ConfigureAwait(false);
            lock (_finishedStats)
            {
                _finishedStats.Add(final.Stats);
            }

            // Late OnDrop notifications run on the client's background thread; give them a moment.
            await Task.Delay(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
            WriteSample(csv, clock);
            samples.WriteTo(Path.Combine(options.ReportDirectory, "stand-in-samples.jsonl"));

            var stored = options.Upstream is null ? new HashSet<Guid>(standIn.Stored.Keys) : await ReadBackAsync(started).ConfigureAwait(false);
            return Report(standIn, stored, drained, drainSeconds, clock.Elapsed);
        }

        private LogbirdClient NewClient(Uri endpoint) => new(new LogbirdOptions
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

        private void OnDrop(DroppedEvent drop)
        {
            _dropReasons.AddOrUpdate(drop.Reason, 1, (_, n) => n + 1);
            if (drop.Id is null || !Guid.TryParse(drop.Id, out var id))
            {
                Interlocked.Increment(ref _droppedWithoutId);
                return;
            }

            if (!_dropped.TryAdd(id, drop.Reason))
            {
                Interlocked.Increment(ref _doubleDrops);
            }
        }

        private async Task ProduceAsync(int producer, CancellationToken stop)
        {
            // Each producer sends its share in small bursts every 20 ms, so the total rate holds without a tight loop.
            var perTick = Math.Max(1, (int)Math.Round(options.Rate / (double)options.Producers / 50.0));
            var tick = TimeSpan.FromMilliseconds(20);
            var actions = new[] { "booking.created", "booking.cancelled", "invoice.paid", "user.signed_in", "settings.updated" };
            var n = 0;
            while (!stop.IsCancellationRequested)
            {
                for (var i = 0; i < perTick; i++)
                {
                    var id = LogbirdClient.NewEventId();
                    _tracked.TryAdd(Guid.Parse(id), 0);
                    var e = new AuditEvent(actions[n++ % actions.Length])
                    {
                        Id = id,
                        Actor = AuditActor.User("soak_user_" + (n % 97), "Soak User", "soak." + (n % 97) + "@example.invalid"),
                        Tenant = new AuditTenant("soak_tenant_" + (n % 7)),
                    }
                    .Target("record", "soak_" + producer + "_" + n)
                    .WithMetadata("soakRun", _runId);
                    var started = Stopwatch.GetTimestamp();
                    try
                    {
                        Volatile.Read(ref _client)!.Track(e);
                    }
                    catch (Exception)
                    {
                        Interlocked.Increment(ref _trackThrew);
                    }

                    _trackLatency.Add(Stopwatch.GetTimestamp() - started);
                }

                try
                {
                    await Task.Delay(tick, stop).ConfigureAwait(false);
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

                // Swap first, then dispose the old client while producers already write to the new one.
                var old = Interlocked.Exchange(ref _client, NewClient(endpoint))!;
                await Task.Delay(100).ConfigureAwait(false);
                await old.DisposeAsync().ConfigureAwait(false);
                lock (_finishedStats)
                {
                    _finishedStats.Add(old.Stats);
                }

                Interlocked.Increment(ref _restarts);
            }
        }

        private async Task FlushAsync(CancellationToken stop)
        {
            // A flush settles what was queued before it; under faults that can take a batch's full retry budget (five
            // minutes), so a flush is stuck only beyond that budget plus slack.
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
                try
                {
                    await client.FlushAsync(timeout.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (timeout.IsCancellationRequested)
                {
                    Interlocked.Increment(ref _flushesStuck);
                }
                catch (ObjectDisposedException)
                {
                    // A restart disposed this client meanwhile; its shutdown settles the rest.
                }

                lock (_flushSeconds)
                {
                    _flushSeconds.Add(watch.Elapsed.TotalSeconds);
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

        private void WriteSample(StreamWriter csv, Stopwatch clock)
        {
            using var process = Process.GetCurrentProcess();
            var stats = Volatile.Read(ref _client)!.Stats;
            var sample = new ResourceSample(
                clock.Elapsed.TotalSeconds,
                GC.GetTotalMemory(forceFullCollection: true),
                process.WorkingSet64,
                process.HandleCount,
                process.Threads.Count,
                stats.QueueLength,
                _tracked.Count);
            lock (_samples)
            {
                _samples.Add(sample);
            }

            csv.WriteLine(string.Join(",",
                sample.Seconds.ToString("F0", CultureInfo.InvariantCulture),
                _tracked.Count, Total(s => s.Delivered, stats), Total(s => s.Rejected, stats), Total(s => s.Dropped, stats), stats.QueueLength,
                (sample.Heap / 1048576.0).ToString("F1", CultureInfo.InvariantCulture),
                (sample.WorkingSet / 1048576.0).ToString("F1", CultureInfo.InvariantCulture),
                sample.Handles, sample.Threads, Interlocked.Read(ref _restarts)));
            csv.Flush();
        }

        private long Total(Func<LogbirdStats, long> pick, LogbirdStats current)
        {
            lock (_finishedStats)
            {
                return _finishedStats.Sum(pick) + pick(current);
            }
        }

        private async Task<HashSet<Guid>> ReadBackAsync(DateTimeOffset started)
        {
            // Layer 2: what the real server stored, by the run tag. Waits until the count stops changing.
            using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = options.Upstream, ReadKey = options.ReadKey, AllowInsecureHttp = true });
            var search = new EventSearch { Query = "metadata.soakRun:" + (char)34 + _runId + (char)34, From = started.AddMinutes(-5), Limit = 200 };
            var ids = new List<Guid>();
            var previous = -1;
            for (var attempt = 0; attempt < 30; attempt++)
            {
                ids.Clear();
                await foreach (var e in reader.SearchAllAsync(search).ConfigureAwait(false))
                {
                    ids.Add(Guid.Parse(e.Id));
                }

                if (ids.Count == previous)
                {
                    break;
                }

                previous = ids.Count;
                await Task.Delay(TimeSpan.FromSeconds(10)).ConfigureAwait(false);
            }

            _readBackDuplicates = ids.Count - ids.Distinct().Count();
            return [.. ids];
        }

        private long _readBackDuplicates;

        private JsonObject Report(StandIn standIn, HashSet<Guid> stored, bool drained, double drainSeconds, TimeSpan elapsed)
        {
            var tracked = new HashSet<Guid>(_tracked.Keys);
            var dropped = new Dictionary<Guid, DropReason>(_dropped);
            var lost = tracked.Where(id => !stored.Contains(id) && !dropped.ContainsKey(id)).Count();
            var both = dropped.Where(d => stored.Contains(d.Key)).ToList();
            var bothConfirmedReason = both.Count(d => !Unconfirmed.Contains(d.Value));
            var strangers = stored.Count(id => !tracked.Contains(id));
            LogbirdStats[] stats;
            lock (_finishedStats)
            {
                stats = [.. _finishedStats];
            }

            var delivered = stats.Sum(s => s.Delivered);
            var rejectedOrDropped = stats.Sum(s => s.Rejected + s.Dropped);
            var storedNotDropped = stored.Count(id => !dropped.ContainsKey(id));
            var undocumented = _dropReasons.Keys.Where(r => !Documented.Contains(r)).Select(r => r.ToString()).ToArray();
            var unexpected = _dropReasons.Keys.Where(r => r is DropReason.TooLarge or DropReason.Invalid or DropReason.InvalidEntityId).Select(r => r.ToString()).ToArray();

            ResourceSample[] samples;
            lock (_samples)
            {
                samples = [.. _samples];
            }

            var resources = Resources(samples);
            var p99 = _trackLatency.Percentile(0.99);
            var checks = new JsonArray
            {
                Check("every tracked event is stored or reported dropped", lost == 0, $"{lost} of {tracked.Count} neither stored nor reported"),
                Check("no event is reported dropped twice", Interlocked.Read(ref _doubleDrops) == 0 && Interlocked.Read(ref _droppedWithoutId) == 0, $"{_doubleDrops} repeated, {_droppedWithoutId} without an id"),
                Check("an event both stored and dropped has an unconfirmed reason", bothConfirmedReason == 0, $"{both.Count} stored and dropped, {bothConfirmedReason} with a confirmed reason"),
                Check("nothing is stored that was not tracked", strangers == 0, $"{strangers} unknown ids stored"),
                Check("no stored event changed content on retry", standIn.Conflicts == 0, $"{standIn.Conflicts} conflicts"),
                Check("every reported drop reason is documented", undocumented.Length == 0 && unexpected.Length == 0, "reasons: " + string.Join(", ", _dropReasons.Select(r => r.Key + "=" + r.Value))),
                Check("Track never threw", Interlocked.Read(ref _trackThrew) == 0, $"{_trackThrew} throws"),
                Check("no flush was stuck", Interlocked.Read(ref _flushesStuck) == 0, $"{_flushesStuck} flushes over 6 minutes"),
                Check("the final drain settled everything", drained, $"final flush {(drained ? "completed" : "did not complete")} in {drainSeconds:F1} s"),
                Check("Track p99 latency under 5 ms", p99 < 5.0, $"p50 {_trackLatency.Percentile(0.5):F3} ms, p99 {p99:F3} ms, max {_trackLatency.Max:F3} ms"),
                Check("the queue never exceeded MaxQueueSize", samples.All(s => s.Queue <= options.MaxQueueSize), $"max queue {samples.Max(s => s.Queue)}"),
                Check("heap stayed bounded", resources.HeapBounded, resources.HeapDetail),
                Check("handle count stayed bounded", resources.HandlesBounded, resources.HandlesDetail),
                Check("thread count stayed bounded", resources.ThreadsBounded, resources.ThreadsDetail),
            };
            if (options.Upstream is null)
            {
                checks.Add(Check("delivered counts match stored events", delivered == storedNotDropped, $"Stats.Delivered {delivered}, stored and not dropped {storedNotDropped}"));
                checks.Add(Check("rejected and dropped counts match drop reports", rejectedOrDropped == dropped.Count, $"Stats.Rejected + Dropped {rejectedOrDropped}, reports {dropped.Count}"));
            }
            else
            {
                checks.Add(Check("the server stored no event twice", _readBackDuplicates == 0, $"{_readBackDuplicates} duplicate ids read back"));
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
                ["runtime"] = Runtime(),
                ["mode"] = options.Upstream is null ? "stand-in" : "upstream",
                ["config"] = options.ToJson(),
                ["elapsedSeconds"] = Math.Round(elapsed.TotalSeconds),
                ["totals"] = new JsonObject
                {
                    ["tracked"] = tracked.Count,
                    ["stored"] = stored.Count,
                    ["delivered"] = delivered,
                    ["dropReports"] = dropped.Count,
                    ["storedAndDropped"] = both.Count,
                    ["restarts"] = Interlocked.Read(ref _restarts),
                    ["requests"] = standIn.Requests,
                    ["connections"] = standIn.Connections,
                    ["resendsAfterStore"] = standIn.Resends,
                },
                ["faults"] = faults,
                ["dropReasons"] = reasons,
                ["errorsReported"] = errors,
                ["trackLatencyMs"] = new JsonObject
                {
                    ["p50"] = Math.Round(_trackLatency.Percentile(0.5), 4),
                    ["p99"] = Math.Round(p99, 4),
                    ["p999"] = Math.Round(_trackLatency.Percentile(0.999), 4),
                    ["max"] = Math.Round(_trackLatency.Max, 4),
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

        /// <summary>
        /// Compares the last third of the run with a baseline taken after warm-up (the first sample after 10% of the run).
        /// Heap is measured after a full collection and may grow by the harness's own bookkeeping (about 200 bytes per
        /// tracked event across its id sets and the stand-in's store) plus 32 MB of slack.
        /// </summary>
        private static ResourceReport Resources(ResourceSample[] samples)
        {
            if (samples.Length < 4)
            {
                return new ResourceReport(true, "too few samples", true, "too few samples", true, "too few samples", samples);
            }

            var end = samples[samples.Length - 1].Seconds;
            var baseline = samples.FirstOrDefault(s => s.Seconds >= end * 0.1) ?? samples[1];
            var late = samples.Where(s => s.Seconds >= end * 2 / 3).ToArray();
            var heapLimit = baseline.Heap + ((late.Max(s => s.Tracked) - baseline.Tracked) * 200L) + (32L << 20);
            var heapMax = late.Max(s => s.Heap);
            var handleLimit = (baseline.Handles * 3 / 2) + 100;
            var handleMax = late.Max(s => s.Handles);
            var threadLimit = baseline.Threads + 50;
            var threadMax = late.Max(s => s.Threads);
            return new ResourceReport(
                heapMax <= heapLimit, $"baseline {baseline.Heap >> 20} MB, late max {heapMax >> 20} MB, limit {heapLimit >> 20} MB",
                handleMax <= handleLimit, $"baseline {baseline.Handles}, late max {handleMax}, limit {handleLimit}",
                threadMax <= threadLimit, $"baseline {baseline.Threads}, late max {threadMax}, limit {threadLimit}",
                samples);
        }

        private static JsonObject Check(string name, bool passed, string detail)
        {
            Console.WriteLine((passed ? "  ok   " : "  FAIL ") + name + ": " + detail);
            return new JsonObject { ["name"] = name, ["passed"] = passed, ["detail"] = detail };
        }
    }

    internal static string Runtime() => System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription + " on " + System.Runtime.InteropServices.RuntimeInformation.OSDescription;

    private sealed record ResourceSample(double Seconds, long Heap, long WorkingSet, int Handles, int Threads, int Queue, int Tracked);

    private sealed record ResourceReport(bool HeapBounded, string HeapDetail, bool HandlesBounded, string HandlesDetail, bool ThreadsBounded, string ThreadsDetail, ResourceSample[] Samples)
    {
        public JsonObject ToJson() => new()
        {
            ["heap"] = HeapDetail,
            ["handles"] = HandlesDetail,
            ["threads"] = ThreadsDetail,
            ["samples"] = Samples.Length,
            ["peakWorkingSetMb"] = Samples.Length == 0 ? 0 : Samples.Max(s => s.WorkingSet) >> 20,
        };
    }
}

/// <summary>A fixed-size histogram of Track durations (Stopwatch ticks), so recording never allocates.</summary>
internal sealed class LatencyHistogram
{
    // Buckets of 1 microsecond up to 1 ms, then 100 microseconds up to 100 ms, then one overflow bucket.
    private readonly long[] _fine = new long[1000];
    private readonly long[] _coarse = new long[990];
    private long _overflow;
    private long _count;
    private long _maxTicks;

    public double Max => Interlocked.Read(ref _maxTicks) * 1000.0 / Stopwatch.Frequency;

    public void Add(long ticks)
    {
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

    /// <summary>The percentile in milliseconds (bucket upper bound).</summary>
    public double Percentile(double p)
    {
        var target = (long)Math.Ceiling(Interlocked.Read(ref _count) * p);
        long seen = 0;
        for (var i = 0; i < _fine.Length; i++)
        {
            seen += Interlocked.Read(ref _fine[i]);
            if (seen >= target)
            {
                return (i + 1) / 1000.0;
            }
        }

        for (var i = 0; i < _coarse.Length; i++)
        {
            seen += Interlocked.Read(ref _coarse[i]);
            if (seen >= target)
            {
                return (1000 + ((i + 1) * 100)) / 1000.0;
            }
        }

        return 100.0;
    }
}
