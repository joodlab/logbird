using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Logbird.Internal;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Logbird;

/// <summary>Records audit events. Implemented by <see cref="LogbirdClient"/>; depend on this interface to fake it in tests.</summary>
public interface ILogbirdClient
{
    /// <summary>Queues an event and returns immediately. Never blocks on the network and never throws.</summary>
    /// <param name="auditEvent">The event. The client takes a snapshot; later changes to the object are not sent.</param>
    void Track(AuditEvent auditEvent);

    /// <summary>
    /// Sends everything queued so far and waits for the result. Returns <see langword="true"/> when every event queued
    /// before the call was stored or permanently settled (rejected or dropped, see <see cref="LogbirdOptions.OnDrop"/>),
    /// and <see langword="false"/> when delivery failed after retries or <paramref name="cancellationToken"/> was
    /// cancelled; unsent events then stay queued. Never throws.
    /// </summary>
    /// <param name="cancellationToken">Stops waiting (delivery continues in the background).</param>
    Task<bool> FlushAsync(CancellationToken cancellationToken = default);

    /// <summary>A snapshot of the client's counters.</summary>
    LogbirdStats Stats { get; }
}

/// <summary>
/// Sends audit events to Logbird in the background. Create one per application (it is thread-safe) and dispose it on
/// shutdown so queued events are sent.
/// </summary>
/// <remarks>
/// <para><see cref="Track"/> serializes the event on the calling thread and queues it in memory. A single background
/// loop sends batches of up to <see cref="LogbirdOptions.BatchSize"/> events, at least every
/// <see cref="LogbirdOptions.FlushInterval"/>. Network errors, 429 and 5xx are retried with backoff, resending the
/// identical bytes so the server never stores an event twice.</para>
/// <para>Nothing Logbird does can throw into your code: problems go to <see cref="LogbirdOptions.OnError"/>,
/// <see cref="LogbirdOptions.OnDrop"/>, the logger and the <c>Logbird</c> meter.</para>
/// <para>Threading contract: <c>Track</c> runs your <see cref="LogbirdOptions.BeforeSend"/> hook and redaction patterns
/// synchronously on the calling thread (they must be fast; a throwing hook drops the event). <see cref="LogbirdOptions.OnDrop"/>,
/// <see cref="LogbirdOptions.OnError"/> and logging run in order on one background thread; their exceptions are swallowed
/// and counted, and if they fall behind by more than <see cref="LogbirdOptions.MaxQueueSize"/> (at least 1,000)
/// notifications, further ones are skipped and counted. Metric instruments are observable, so listeners only run when they
/// collect. <c>FlushAsync()</c> has no time limit of its own; use <see cref="LogbirdClientExtensions.Flush"/> or a token
/// for one. <c>DisposeAsync</c> returns within <see cref="LogbirdOptions.ShutdownTimeout"/> plus at most 7 seconds.</para>
/// <para>The queue lives in memory. A crash before delivery loses what is queued. For events that must survive a crash,
/// save them in your database in the same transaction as the change (an outbox) and send them from there, keeping their ids.</para>
/// </remarks>
public sealed partial class LogbirdClient : ILogbirdClient, IAsyncDisposable, IDisposable
{
    internal const int MaxEventBytes = 256 * 1024;

    // True on Logbird's own delivery flow and while it runs your callbacks. Track calls made there (from an HTTP
    // handler wrapped around Logbird's HttpClient, a logger provider that records events, or OnDrop/OnError) are
    // skipped, so a host that wires HTTP or logging globally can never create a feedback loop.
    private static readonly AsyncLocal<bool> InsideLogbird = new();
    internal const int MaxBatchBytes = 5 * 1024 * 1024;

    private readonly bool _enabled;
    private readonly string? _environment;
    private readonly string? _source;
    private readonly Func<AuditEvent, AuditEvent?>? _beforeSend;
    private readonly Redactor? _redactor;
    private readonly int _batchSize;
    private readonly TimeSpan _flushInterval;
    private readonly TimeSpan _shutdownTimeout;
    private readonly Action<Exception>? _onError;
    private readonly Action<DroppedEvent>? _onDrop;
    private readonly ILogger _logger;
    private readonly Notifier _notifier;
    private readonly EventQueue? _queue;
    private readonly BatchSender? _sender;
    private readonly HttpClient? _ownedHttp;
    private readonly SemaphoreSlim _signal = new(0);
    private readonly CancellationTokenSource _stop = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly Task? _loop;

    private int _signaled;
    private readonly object _disposeGate = new();
    private readonly object _abandonGate = new();
    private Task? _disposeTask;
    private volatile bool _closing;
    private volatile bool _flushRequested;
    private long _firstQueuedAtTicks;
    private long _retryAtTicks;
    private int _consecutiveFailures;
    private long _lastQueueFullLogTicks = long.MinValue / 2; // far enough back that the first warning is logged, without overflow

    private long _tracked;
    private long _delivered;
    private long _rejected;
    private long _dropped;
    private long _filtered;
    private long _failedSends;
    private long _warnings;
    private long _notificationsLost;
    private long _callbackFailures;
    private readonly long[] _droppedByReason = new long[DropReasonCount];

    [ThreadStatic]
    private static List<string>? _whitespaceFields;

    /// <summary>Creates a client.</summary>
    /// <param name="options">Settings. They are read once; later changes have no effect.</param>
    /// <param name="httpClient">
    /// An <see cref="HttpClient"/> to send with, for example one from <c>IHttpClientFactory</c>. The client does not
    /// dispose it. When omitted, the client creates and owns one.
    /// </param>
    /// <param name="logger">Receives delivery warnings. Optional.</param>
    /// <exception cref="ArgumentException">The options are invalid, for example a missing endpoint or key while enabled.</exception>
    public LogbirdClient(LogbirdOptions options, HttpClient? httpClient = null, ILogger? logger = null)
        : this(options, httpClient, logger, delay: null)
    {
    }

    internal LogbirdClient(LogbirdOptions options, HttpClient? httpClient, ILogger? logger, Func<TimeSpan, CancellationToken, Task>? delay)
    {
        Guard.NotNull(options, nameof(options));
        options.Validate();
        _enabled = options.Enabled;
        _environment = options.Environment;
        _source = options.Source;
        _beforeSend = options.BeforeSend;
        _redactor = options.Redaction.CreateRedactor();
        _batchSize = options.BatchSize;
        _flushInterval = options.FlushInterval;
        _shutdownTimeout = options.ShutdownTimeout;
        _onError = options.OnError;
        _onDrop = options.OnDrop;
        _logger = logger ?? NullLogger.Instance;
        _notifier = new Notifier(Math.Max(1_000, options.MaxQueueSize), lost => Interlocked.Add(ref _notificationsLost, lost), () => Interlocked.Increment(ref _callbackFailures));
        List<string>? identifierFields = null;
        try
        {
            identifierFields = _redactor?.IdentifierFieldsMatched();
        }
        catch (Exception e)
        {
            // Diagnostics must never fail construction.
            Report(new LogbirdDeliveryException("Checking the redaction pattern failed: " + e.GetType().Name));
        }

        if (identifierFields is { Count: > 0 })
        {
            // Reported once, at startup: identifier fields are structural and are never redacted.
            Report(new LogbirdDeliveryException(
                $"The redaction pattern matches identifier field(s) {string.Join(", ", identifierFields)}. Identifier fields are never redacted; "
                + "to pseudonymise an id, transform it before recording."));
        }

        if (!_enabled)
        {
            return;
        }

        var http = httpClient ?? (_ownedHttp = CreateHttpClient());
        _queue = new EventQueue(options.MaxQueueSize, options.QueueFullBehavior, OnEvicted);
        _sender = new BatchSender(http, options.Endpoint!, options.IngestKey!, options.MaxRetries, options.RequestTimeout, OnSenderDrop, OnSenderWarning, () => _queue!.CompleteSatisfiedWaiters(), Report, delay);
        _loop = Task.Run(RunAsync);
        LogbirdMetrics.Register(this);
    }

    internal const int DropReasonCount = (int)DropReason.Unacknowledged + 1;

    /// <summary>The SDK version sent in the <c>X-Logbird-SDK</c> header.</summary>
    public static string Version { get; } = ReadVersion();

    /// <inheritdoc />
    public LogbirdStats Stats => new(
        Interlocked.Read(ref _tracked),
        Interlocked.Read(ref _delivered),
        Interlocked.Read(ref _rejected),
        Interlocked.Read(ref _dropped),
        Interlocked.Read(ref _filtered),
        Interlocked.Read(ref _failedSends),
        _queue?.Outstanding ?? 0,
        Interlocked.Read(ref _warnings));

    /// <summary>
    /// Creates a new event id (a UUIDv7, sortable by time). Use it when you store an event before sending it, so a
    /// replay keeps the same id and Logbird keeps one copy.
    /// </summary>
    public static string NewEventId() => UuidV7.NewId();

    /// <inheritdoc />
    public void Track(AuditEvent auditEvent) => TrackCore(auditEvent);

    /// <summary>
    /// <see cref="Track"/>, returning the id the event was queued or reported under (after <see cref="LogbirdOptions.BeforeSend"/>
    /// and the repair of a blank id), or the caller's id when the event was not processed.
    /// </summary>
    internal string? TrackCore(AuditEvent auditEvent)
    {
        if (!_enabled)
        {
            return auditEvent?.Id;
        }

        if (InsideLogbird.Value)
        {
            Interlocked.Increment(ref _filtered);
            return auditEvent?.Id;
        }

        string? id = null;
        var action = auditEvent?.Action ?? string.Empty;
        byte[]? json = null;
        InsideLogbird.Value = true;
        try
        {
            Guard.NotNull(auditEvent, nameof(auditEvent));
            if (_closing)
            {
                Drop(DropReason.Shutdown, auditEvent!.Id, action, null, "The client is shut down.");
                Report(new ObjectDisposedException(nameof(LogbirdClient), "Logbird is shut down; the event was not recorded."));
                return id ?? auditEvent?.Id;
            }

            var source = auditEvent!;
            if (CheckShape(source, auditEvent!.Id, action))
            {
                return id ?? auditEvent?.Id;
            }

            id = source.Id ?? UuidV7.NewId();
            DateTimeOffset? occurredAt = source.OccurredAt ?? DateTimeOffset.UtcNow;
            string? environment = _environment;
            string? defaultSource = _source;
            var fullEnvelope = true;
            if (_beforeSend is not null)
            {
                // Like the TypeScript SDK: defaults, id, timestamp, context and metadata are applied before the hook, and
                // what the hook returns is sent as it is (only a missing or blank id is repaired).
                var copy = source.Clone();
                copy.Id = id;
                copy.OccurredAt = occurredAt;
                copy.Environment ??= _environment;
                copy.Source ??= _source;
                _ = copy.Context;
                _ = copy.Metadata;
                var result = _beforeSend(copy);
                if (result is null)
                {
                    Interlocked.Increment(ref _filtered);
                    return id ?? auditEvent?.Id;
                }

                source = result;
                action = source.Action ?? string.Empty;
                id = source.Id;
                occurredAt = source.OccurredAt;
                environment = null;
                defaultSource = null;
                fullEnvelope = false;
                if (CheckShape(source, id, action))
                {
                    return id ?? auditEvent?.Id;
                }
            }

            // The server mints a fresh id for a missing or blank id, which a retry could never match. Mint it here instead.
            if (id is null || EventJson.JsTrim(id).Length == 0)
            {
                id = UuidV7.NewId();
            }

            // Identifiers are sent exactly as given. One the server could not store as sent drops the event here, with the
            // server's reason; surrounding whitespace is kept and reported once the event is queued.
            var whitespace = _whitespaceFields ??= [];
            whitespace.Clear();
            if (EntityIds.Validate(source, whitespace) is { } invalidEntity)
            {
                Drop(DropReason.InvalidEntityId, id, action, null, invalidEntity);
                Report(new LogbirdDeliveryException("An audit event was dropped: " + invalidEntity));
                return id ?? auditEvent?.Id;
            }

            var node = EventJson.ToJsonObject(source, id, occurredAt, environment, defaultSource, fullEnvelope);
            _redactor?.RedactInPlace(node);
            json = EventJson.ToUtf8(node);
            if (json.Length > MaxEventBytes)
            {
                // The payload is not kept: holding oversized bodies in the callback backlog could exhaust memory.
                Drop(DropReason.TooLarge, id, action, null, "The event exceeds 256 KB.");
                Report(new LogbirdDeliveryException("An audit event exceeds 256 KB and was dropped."));
                return id ?? auditEvent?.Id;
            }

            var eventId = id;
            var eventJson = json;
            var eventAction = action;
            var overflow = _queue!.Enqueue(sequence => new QueuedEvent(eventJson, eventId, eventAction, sequence), out var added, out var count, out var shutDown);
            if (shutDown)
            {
                Drop(DropReason.Shutdown, eventId, eventAction, eventJson, "The client is shut down.");
                Report(new ObjectDisposedException(nameof(LogbirdClient), "Logbird is shut down; the event was not recorded."));
                return id ?? auditEvent?.Id;
            }

            if (added is not null)
            {
                foreach (var field in whitespace)
                {
                    Warn(eventId, eventAction, $"surrounding whitespace in {field} is kept as sent", $"surrounding whitespace in {field}");
                }

                Interlocked.Increment(ref _tracked);
                if (count == 1)
                {
                    Interlocked.Exchange(ref _firstQueuedAtTicks, _clock.Elapsed.Ticks);
                    Signal();
                }
                else if (count >= _batchSize)
                {
                    Signal();
                }
            }

            if (overflow is not null)
            {
                if (added is not null)
                {
                }

                overflow.TrySettle();
                Drop(DropReason.QueueFull, overflow.Id, overflow.Action, overflow.Json, "The queue is full.");
                LogQueueFull();
            }
        }
        catch (Exception e)
        {
            Drop(DropReason.Invalid, id, action, json, e.GetType().Name);

            // Host exceptions (from BeforeSend, a redaction pattern, a JSON value) can quote event data, so only the
            // exception type is reported, never the exception itself.
            Report(e is SdkDropException ? e : new LogbirdDeliveryException("An audit event could not be recorded: " + e.GetType().Name));
        }
        finally
        {
            InsideLogbird.Value = false;
        }

        return id ?? auditEvent?.Id;
    }

    /// <summary>Reports an SDK-owned diagnostic through the background notifier (logger and OnError), off the caller's thread.</summary>
    internal void ReportDiagnostic(string message) => Report(new LogbirdDeliveryException(message));

    /// <summary>Counts and reports, once, an event that an integration could not hand to <see cref="Track"/>.</summary>
    internal void DropUnrecorded(DropReason reason, string? id, string? action, string detail)
    {
        if (!_enabled)
        {
            return;
        }

        Drop(reason, id, action ?? string.Empty, null, detail);
        Report(new LogbirdDeliveryException("An audit event was dropped: " + detail));
    }

    /// <summary>
    /// For a host whose own shutdown budget ran out: stops accepting events and reports everything still unsent now, once
    /// each, instead of waiting for <see cref="LogbirdOptions.ShutdownTimeout"/>. A late response is ignored.
    /// </summary>
    internal void AbandonNow()
    {
        try
        {
            var dispose = StartDispose();
            if (!dispose.IsCompleted && _queue is not null)
            {
                AbandonRemaining();
            }
        }
        catch (Exception e)
        {
            Report(new LogbirdDeliveryException("Logbird shutdown step failed: " + e.GetType().Name));
        }
    }

    /// <inheritdoc />
    public async Task<bool> FlushAsync(CancellationToken cancellationToken = default)
    {
        if (!_enabled || _queue is null)
        {
            return true;
        }

        // From Logbird's own delivery flow (OnDrop, OnError, a logger or HTTP handler), waiting would wait on itself.
        if (InsideLogbird.Value)
        {
            return false;
        }

        var result = await FlushCoreAsync(cancellationToken).ConfigureAwait(false);

        // Callbacks for what this flush settled (OnDrop, OnError) have run when it returns.
        try
        {
            await _notifier.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Waiting for diagnostics is best effort.
        }

        return result && !cancellationToken.IsCancellationRequested;
    }

    private async Task<bool> FlushCoreAsync(CancellationToken cancellationToken)
    {
        try
        {
            var waiter = _queue!.AddWaiter();
            if (waiter is null)
            {
                return true;
            }

            _flushRequested = true;
            Signal();
            if (_loop!.IsCompleted)
            {
                _queue.CompleteAllWaiters(_queue.Outstanding == 0);
            }

            if (!cancellationToken.CanBeCanceled)
            {
                return await waiter.Completion.Task.ConfigureAwait(false);
            }

            // Concurrent flushes for the same events share one waiter; each caller cancels only its own wait.
            var cancelled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            using (cancellationToken.Register(() => cancelled.TrySetResult(false)))
            {
                if (await Task.WhenAny(waiter.Completion.Task, cancelled.Task).ConfigureAwait(false) == waiter.Completion.Task)
                {
                    return await waiter.Completion.Task.ConfigureAwait(false);
                }

                _queue.ReleaseWaiter(waiter);
                return false;
            }
        }
        catch (Exception e)
        {
            Report(new LogbirdDeliveryException("Logbird flush failed unexpectedly: " + e.GetType().Name));
            return false;
        }
    }

    /// <summary>
    /// Stops accepting events and sends what is queued, waiting at most <see cref="LogbirdOptions.ShutdownTimeout"/>
    /// (plus up to two seconds for a cancelled request to unwind). Events still unsent afterwards, including a batch
    /// whose request has not returned, are reported once each through <see cref="LogbirdOptions.OnDrop"/>; a late
    /// response is then ignored. Never throws.
    /// </summary>
    public ValueTask DisposeAsync() => new(StartDispose());

    /// <summary>Starts disposal once; every disposer waits for the same operation.</summary>
    private Task StartDispose()
    {
        lock (_disposeGate)
        {
            // Closing is set before anything else, so Track rejects new events even if disposal has not run yet.
            _closing = true;
            return _disposeTask ??= DisposeCoreAsync();
        }
    }

    private async Task DisposeCoreAsync()
    {
        if (_loop is null)
        {
            _ownedHttp?.Dispose();
            return;
        }

        try
        {
            _closing = true;
            Signal();
            var finished = await Task.WhenAny(_loop, Task.Delay(_shutdownTimeout)).ConfigureAwait(false) == _loop;
            if (!finished)
            {
                // Cancellation runs the handlers' callbacks synchronously; one that throws or blocks must not stop
                // shutdown, so cancel on the thread pool and wait only briefly for the loop to unwind.
                _ = Task.Run(() =>
                {
                    try
                    {
                        _stop.Cancel();
                    }
                    catch (Exception e)
                    {
                        Report(new LogbirdDeliveryException("Logbird shutdown step failed: " + e.GetType().Name));
                    }
                });
                await Task.WhenAny(_loop, Task.Delay(TimeSpan.FromSeconds(2))).ConfigureAwait(false);
            }
        }
        catch (Exception e)
        {
            Report(new LogbirdDeliveryException("Logbird shutdown step failed: " + e.GetType().Name));
        }
        finally
        {
            AbandonRemaining();
        }

        // Let OnDrop/OnError see what shutdown reported, without letting a blocked callback hold shutdown.
        try
        {
            await Task.WhenAny(_notifier.WaitAsync(CancellationToken.None), Task.Delay(TimeSpan.FromSeconds(5))).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Best effort.
        }
        finally
        {
            LogbirdMetrics.Unregister(this);
        }
    }

    /// <summary>
    /// Shutdown takes ownership of everything unsent, the in-flight batch included, and reports each event exactly
    /// once. A late response for an abandoned batch is ignored.
    /// </summary>
    private void AbandonRemaining()
    {
        // One report at a time: a second caller returns only after the first has posted every drop.
        lock (_abandonGate)
        {
            AbandonRemainingCore();
        }
    }

    private void AbandonRemainingCore()
    {
        try
        {
            var (queued, inFlight, waiters) = _queue!.Abandon();

            // In-flight events already left the queue-length gauge when they were dequeued.
            foreach (var item in inFlight)
            {
                Drop(DropReason.Shutdown, item.Id, item.Action, item.Json, "The shutdown timeout ran out before the event was sent.");
            }

            foreach (var item in queued)
            {
                Drop(DropReason.Shutdown, item.Id, item.Action, item.Json, "The shutdown timeout ran out before the event was sent.");
            }

            var abandoned = queued.Count + inFlight.Count;

            // Each flush learns whether its own events were settled before shutdown took the rest; flushes that
            // arrived during the report complete now.
            foreach (var (waiter, result) in waiters)
            {
                waiter.Completion.TrySetResult(result);
            }

            _queue.FinishAbandon(abandoned > 0);
            if (abandoned > 0)
            {
                Notify(() => LogShutdownDropped(_logger, abandoned));
                Report(new LogbirdDeliveryException($"{abandoned} audit event(s) were not sent before shutdown."), log: false);
            }
        }
        catch (Exception e)
        {
            Report(new LogbirdDeliveryException("Logbird shutdown step failed: " + e.GetType().Name));
        }
        finally
        {
            _ownedHttp?.Dispose();
        }
    }

    /// <summary>
    /// Same as <see cref="DisposeAsync"/>, blocking the calling thread for at most
    /// <see cref="LogbirdOptions.ShutdownTimeout"/> plus a few seconds. Safe on threads with a synchronization context
    /// (WinForms, WPF, classic ASP.NET): the work runs on the thread pool, so it cannot deadlock.
    /// </summary>
    public void Dispose()
    {
        try
        {
            // Starts (or joins) disposal on this thread up to its first await, then waits without capturing a
            // synchronization context. If the pool is too busy to finish in time, shutdown takes ownership of the
            // remaining events right here, so nothing stays queued unreported when Dispose returns.
            var dispose = StartDispose();
            if (!dispose.Wait(_shutdownTimeout + TimeSpan.FromSeconds(10)) && _queue is not null)
            {
                AbandonRemaining();
            }
        }
        catch (Exception e)
        {
            Report(new LogbirdDeliveryException("Logbird shutdown step failed: " + e.GetType().Name));
        }
    }

    internal static bool IsInsideDelivery => InsideLogbird.Value;

    private static HttpClient CreateHttpClient()
    {
#if NET8_0_OR_GREATER
        var handler = new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5), AllowAutoRedirect = false };
#else
        var handler = new HttpClientHandler { AllowAutoRedirect = false };
#endif

        // Never follow redirects: a redirect would forward the audit body to another origin. A 3xx is reported as a
        // permanent HTTP error instead.
        return new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    private static string ReadVersion()
    {
        var informational = typeof(LogbirdClient).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (string.IsNullOrEmpty(informational))
        {
            return "0.0.0";
        }

        var plus = informational!.IndexOf('+');
        return plus < 0 ? informational : informational.Substring(0, plus);
    }

    private void Signal()
    {
        if (Interlocked.Exchange(ref _signaled, 1) == 0)
        {
            _signal.Release();
        }
    }

    private async Task RunAsync()
    {
        InsideLogbird.Value = true;
        while (true)
        {
            try
            {
                var count = _queue!.Count;
                if (_closing && count == 0)
                {
                    break;
                }

                TimeSpan wait;
                var drainAll = true;
                if (_flushRequested || _closing)
                {
                    wait = TimeSpan.Zero;
                }
                else if (count == 0)
                {
                    wait = Timeout.InfiniteTimeSpan;
                }
                else
                {
                    var now = _clock.Elapsed.Ticks;
                    var retryAt = Interlocked.Read(ref _retryAtTicks);
                    var intervalDue = Math.Max(retryAt, Interlocked.Read(ref _firstQueuedAtTicks) + _flushInterval.Ticks);
                    var due = count >= _batchSize ? retryAt : intervalDue;

                    // A full batch goes out at once; the remainder waits for the interval, a flush or shutdown.
                    drainAll = now >= intervalDue;
                    wait = due > now ? TimeSpan.FromTicks(due - now) : TimeSpan.Zero;
                }

                if (wait != TimeSpan.Zero)
                {
                    await _signal.WaitAsync(wait).ConfigureAwait(false);
                    Interlocked.Exchange(ref _signaled, 0);
                    continue;
                }

                var failed = !await DrainAsync(fullBatchesOnly: !drainAll).ConfigureAwait(false);
                if (failed && _closing)
                {
                    // Like the TypeScript SDK's shutdown: one delivery attempt with its retries, then give up.
                    break;
                }
            }
            catch (Exception e)
            {
                // Defensive: the loop must survive anything, or capture would silently stop.
                Report(new LogbirdDeliveryException("Logbird delivery loop recovered from " + e.GetType().Name));
                _queue!.CompleteWaitersAfterFailure();
                await Task.Delay(TimeSpan.FromSeconds(1)).ConfigureAwait(false);
            }
        }

        _queue!.CompleteAllWaiters(_queue.Outstanding == 0);
    }

    /// <summary>Sends until the queue is empty (or holds less than a full batch). Returns false when a batch failed after its retries.</summary>
    private async Task<bool> DrainAsync(bool fullBatchesOnly)
    {
        if (!fullBatchesOnly)
        {
            _flushRequested = false;
        }

        while (true)
        {
            if (fullBatchesOnly && _queue!.Count < _batchSize)
            {
                break;
            }

            var batch = _queue!.TakeBatch(_batchSize, MaxBatchBytes);
            if (batch.Length == 0)
            {
                break;
            }

            SendResult result;
            try
            {
                result = await _sender!.SendAsync(batch, _stop.Token).ConfigureAwait(false);
            }
            catch (Exception e)
            {
                // Defensive (SendAsync catches everything): requeue only events nobody has settled.
                result = new SendResult([.. batch.Where(item => item.IsPending)], new LogbirdDeliveryException("Logbird delivery failed unexpectedly: " + e.GetType().Name), 0);
            }

            if (result.Delivered > 0)
            {
                Interlocked.Add(ref _delivered, result.Delivered);
            }

            if (!_queue.FinishBatch(result.Failure is null ? [] : result.Unsettled, out _))
            {
                // Shutdown took ownership of this batch and reported it; ignore the late result.
                return false;
            }

            if (result.Failure is { } failure)
            {
                Interlocked.Increment(ref _failedSends);
                _consecutiveFailures++;
                var backoff = TimeSpan.FromSeconds(Math.Min(60, Math.Pow(2, Math.Min(_consecutiveFailures - 1, 6))));
                if (backoff < _flushInterval)
                {
                    backoff = _flushInterval;
                }

                var now = _clock.Elapsed.Ticks;
                Interlocked.Exchange(ref _retryAtTicks, now + backoff.Ticks);
                Interlocked.Exchange(ref _firstQueuedAtTicks, now);

                // Post the diagnostics first (they run on the notifier, so nothing here can block), then answer the
                // flush requests: a flush returns after the callbacks for its failure have run. Retry after the backoff,
                // unless a new flush asks again.
                var unsettledCount = result.Unsettled.Count;
                Notify(() => LogDeliveryFailed(_logger, unsettledCount, backoff.TotalSeconds, failure));
                Report(failure, log: false);
                _flushRequested = false;
                _queue.CompleteWaitersAfterFailure();
                return false;
            }

            _consecutiveFailures = 0;
            Interlocked.Exchange(ref _retryAtTicks, 0);
            _queue.CompleteSatisfiedWaiters();
        }

        _queue!.CompleteSatisfiedWaiters();
        if (_queue.Outstanding == 0)
        {
            Interlocked.Exchange(ref _firstQueuedAtTicks, _clock.Elapsed.Ticks);
        }

        return true;
    }

    /// <summary>Runs a host callback or log call on the notifier, inside the feedback guard.</summary>
    private void Notify(Action notification)
        => _notifier.Post(() =>
        {
            InsideLogbird.Value = true;
            notification();
        });

    /// <summary>
    /// Checks depth and size before anything clones or serializes the event. Returns true when it was dropped (and
    /// reported); oversized events are dropped without keeping their payload.
    /// </summary>
    private bool CheckShape(AuditEvent auditEvent, string? id, string action)
    {
        var shape = JsonDepth.Measure(auditEvent, MaxEventBytes);
        if (shape == JsonDepth.Shape.TooDeep)
        {
            throw new SdkDropException($"An audit event nests JSON deeper than {JsonDepth.Max} levels and was dropped.");
        }

        if (shape == JsonDepth.Shape.TooLarge)
        {
            Drop(DropReason.TooLarge, id, action, null, "The event exceeds 256 KB.");
            Report(new LogbirdDeliveryException("An audit event exceeds 256 KB and was dropped."));
            return true;
        }

        return false;
    }

    /// <summary>Accounts an event evicted from a full queue. Runs under the queue lock: counters and a posted notification only.</summary>
    private void OnEvicted(QueuedEvent item)
    {
        Drop(DropReason.QueueFull, item.Id, item.Action, item.Json, "The queue is full.");
        LogQueueFull();
    }

    private static string? Bounded(string? value, int max = 256)
        => value is null || value.Length <= max ? value : value.Substring(0, max);

    private void OnSenderDrop(QueuedEvent item, DropReason reason, string? detail)
        => Drop(reason, item.Id, item.Action, item.Json, detail);

    // A server reason can quote the event's values; the message and log line keep only its leading field or code.
    private void OnSenderWarning(QueuedEvent item, string reason)
        => Warn(item.Id, item.Action, reason, "server warning (" + SafePrefix(reason) + ")");

    // A server reason is free text that can quote the event's values; the summary names only a fixed topic.
    private static string SafePrefix(string reason)
        => reason.Contains("occurredAt") ? "occurredAt"
            : reason.Contains("whitespace") || reason.Contains("Whitespace") ? "identifier whitespace"
            : reason.Contains("id") ? "id"
            : "other";

    private void Warn(string id, string action, string reason, string summary)
    {
        Interlocked.Increment(ref _warnings);
        Report(new LogbirdEventWarning(id, action, reason, summary));
    }

    internal long NotificationsLost => Interlocked.Read(ref _notificationsLost);

    internal long CallbackFailures => Interlocked.Read(ref _callbackFailures);

    internal void AddDroppedByReason(long[] totals)
    {
        for (var i = 0; i < totals.Length && i < _droppedByReason.Length; i++)
        {
            totals[i] += Interlocked.Read(ref _droppedByReason[i]);
        }
    }

    private void Drop(DropReason reason, string? id, string action, byte[]? json, string? detail)
    {
        if ((int)reason >= 0 && (int)reason < _droppedByReason.Length)
        {
            Interlocked.Increment(ref _droppedByReason[(int)reason]);
        }

        if (reason == DropReason.Rejected)
        {
            Interlocked.Increment(ref _rejected);
        }
        else
        {
            Interlocked.Increment(ref _dropped);
        }

        if (_onDrop is { } onDrop)
        {
            // Display fields are bounded (an oversized action or id must not be kept whole in the backlog); the JSON, when
            // kept, carries the event for replay.
            var dropped = new DroppedEvent(reason, Bounded(id), Bounded(action)!, json, Bounded(detail, 1_024));
            Notify(() => onDrop(dropped));
        }
    }

    private void Report(Exception error) => Report(error, log: true);

    private void Report(Exception error, bool log) => Notify(() => ReportCore(error, log));

    private void ReportCore(Exception error, bool log)
    {
        // Logger and OnError are separate host code: a failure in one is counted and does not skip the other.
        if (log)
        {
            try
            {
                // Only SDK-owned messages reach the logger; never a raw exception that could quote event data.
                LogError(_logger, error is LogbirdDeliveryException or ObjectDisposedException ? error.Message : "An unexpected error: " + error.GetType().Name, null);
            }
            catch
            {
                Interlocked.Increment(ref _callbackFailures);
            }
        }

        if (_onError is null)
        {
            return;
        }

        try
        {
            _onError(error);
        }
        catch
        {
            Interlocked.Increment(ref _callbackFailures);
        }
    }

    private void LogQueueFull()
    {
        var now = _clock.Elapsed.Ticks;
        var last = Interlocked.Read(ref _lastQueueFullLogTicks);
        if (now - last < TimeSpan.TicksPerSecond * 10 || Interlocked.CompareExchange(ref _lastQueueFullLogTicks, now, last) != last)
        {
            return;
        }

        var dropped = Interlocked.Read(ref _dropped);
        Notify(() => LogQueueFullWarning(_logger, dropped));
    }

    [LoggerMessage(EventId = 1, Level = LogLevel.Warning, Message = "Logbird: {Message}")]
    private static partial void LogError(ILogger logger, string message, Exception? exception);

    [LoggerMessage(EventId = 2, Level = LogLevel.Warning, Message = "Logbird delivery failed; {Count} event(s) kept in the queue, next attempt in {DelaySeconds} s")]
    private static partial void LogDeliveryFailed(ILogger logger, int count, double delaySeconds, Exception exception);

    [LoggerMessage(EventId = 3, Level = LogLevel.Warning, Message = "Logbird queue is full; audit events are being dropped ({Dropped} dropped so far)")]
    private static partial void LogQueueFullWarning(ILogger logger, long dropped);

    [LoggerMessage(EventId = 4, Level = LogLevel.Error, Message = "Logbird shut down with {Count} unsent audit event(s)")]
    private static partial void LogShutdownDropped(ILogger logger, int count);

    /// <summary>A drop the SDK itself decided; its message is SDK-owned and safe to forward as it is.</summary>
    private sealed class SdkDropException(string message) : LogbirdDeliveryException(message);
}
