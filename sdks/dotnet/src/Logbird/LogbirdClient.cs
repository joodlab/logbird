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
/// notifications, further ones are skipped and counted on <c>logbird.notifications.lost</c>. One exception: the first time
/// any is skipped, a single notice saying so goes to the logger and <see cref="LogbirdOptions.OnError"/> directly on the
/// thread pool (the ordered queue is full at that moment), so it can run while another callback is running and a flush does
/// not wait for it. Metric instruments are observable, so listeners only run when they collect. <c>FlushAsync()</c> has no
/// time limit of its own; use <see cref="LogbirdClientExtensions.Flush"/> or a token for one. <c>DisposeAsync</c> waits up
/// to <see cref="LogbirdOptions.ShutdownTimeout"/> for delivery and up to 2 more seconds for a cancelled request to unwind,
/// then reports what is left as <see cref="DropReason.Shutdown"/> (in-memory work, no I/O, proportional to the events
/// left), then waits up to 5 seconds for pending callbacks. <c>Dispose</c> runs the same steps on the thread pool and
/// blocks for at most <see cref="LogbirdOptions.ShutdownTimeout"/> plus 10 seconds, counted from the call.</para>
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
    private Task? _abandonNow;
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
    private int _lostReported;
    private long _callbackFailures;

    [ThreadStatic]
    private static List<EntityIds.Warning>? _identifierWarnings;

    /// <summary>The capacity of this thread's reusable warning list, or null when it has none (for tests).</summary>
    internal static int? IdentifierWarningCapacity => _identifierWarnings?.Capacity;

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
        _notifier = new Notifier(Math.Max(1_000, options.MaxQueueSize), OnNotificationsLost, () => Count(ref _callbackFailures, ref LogbirdMetrics.CallbackFailuresTotal));
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
        _sender = new BatchSender(http, options.Endpoint!, options.IngestKey!, options.MaxRetries, options.RequestTimeout, OnSenderDrop, OnSenderWarning, () => _queue!.CompleteSatisfiedWaiters(), Report, delay,
            delivered: () => Count(ref _delivered, ref LogbirdMetrics.DeliveredTotal),
            countDrop: CountDrop,
            settle: (item, count) => _queue!.Settle(item, count),
            reserveReport: ReserveReport);
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
            Count(ref _filtered, ref LogbirdMetrics.FilteredTotal);
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
                    Count(ref _filtered, ref LogbirdMetrics.FilteredTotal);
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

            // Identifiers are sent exactly as given and the server decides: the SDK never refuses an event for one. A property
            // a server may index differently from what is sent is reported as a warning once the event is queued (on the
            // notification thread, so the event may already be on its way).
            var identifierWarnings = _identifierWarnings ??= [];
            identifierWarnings.Clear();
            EntityIds.Inspect(source, identifierWarnings);

            // The size limit applies to what is sent: after BeforeSend and redaction. The writer stops as soon as the output
            // passes the limit, so an oversized value costs no more than the limit itself.
            var node = EventJson.ToJsonObject(source, id, occurredAt, environment, defaultSource, fullEnvelope);
            _redactor?.RedactInPlace(node);
            json = JsJson.ToUtf8(node, MaxEventBytes);
            if (json is null || json.Length > MaxEventBytes)
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
                if (identifierWarnings.Count > 0)
                {
                    // Field names, limits and fixed text only: the message never carries event data. One notification per
                    // event, so an event with many fields cannot crowd other notifications out of the bounded queue; the
                    // warnings wait in it as compact records and are formatted only when delivered.
                    WarnAll(eventId, eventAction, identifierWarnings.ToArray());
                }

                Count(ref _tracked, ref LogbirdMetrics.TrackedTotal);
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
                overflow.TrySettle();
                Drop(DropReason.QueueFull, overflow.Id, overflow.Action, overflow.Json, "The queue is full.", mayBeStored: overflow.MayBeStored);
                LogQueueFull();
            }
        }
        catch (Exception e)
        {
            // The SDK's own refusals (depth) carry fixed text and say why; anything else is named by its type only.
            Drop(DropReason.Invalid, id ?? auditEvent?.Id, action, json, e is SdkDropException ? e.Message : e.GetType().Name);

            // Host exceptions (from BeforeSend, a redaction pattern, a JSON value) can quote event data, so only the
            // exception type is reported, never the exception itself.
            Report(e is SdkDropException ? e : new LogbirdDeliveryException("An audit event could not be recorded: " + e.GetType().Name));
        }
        finally
        {
            // A rare event with many identifier warnings must not keep a large reusable list alive on this thread,
            // however it ended (queued, dropped, refused or failed).
            if (_identifierWarnings is { Capacity: > 256 })
            {
                _identifierWarnings = null;
            }

            InsideLogbird.Value = false;
        }

        return id ?? auditEvent?.Id;
    }

    /// <summary>
    /// Reports an SDK-owned diagnostic through the background notifier (logger and OnError), off the caller's thread.
    /// Ignored on Logbird's own delivery flow, like <see cref="Track"/>, so a callback cannot feed itself.
    /// </summary>
    internal void ReportDiagnostic(string message)
    {
        if (!InsideLogbird.Value)
        {
            Report(new LogbirdDeliveryException(message));
        }
    }

    /// <summary>
    /// Counts and reports, once, an event that an integration could not hand to <see cref="Track"/>. On Logbird's own
    /// delivery flow (an OnDrop or OnError callback) it is counted as filtered instead, exactly as <see cref="Track"/>
    /// treats events recorded there, so a callback cannot keep the notifier busy.
    /// </summary>
    internal void DropUnrecorded(DropReason reason, string? id, string? action, string detail)
    {
        if (!_enabled)
        {
            return;
        }

        if (InsideLogbird.Value)
        {
            Count(ref _filtered, ref LogbirdMetrics.FilteredTotal);
            return;
        }

        Drop(reason, id, action ?? string.Empty, null, detail);
        Report(new LogbirdDeliveryException("An audit event was dropped: " + detail));
    }

    /// <summary>
    /// For a host whose own shutdown budget ran out: stops accepting events at once and, on the thread pool, stops the
    /// sender (no further attempt or retry starts) and then reports everything not yet delivered, once each, instead of
    /// waiting for <see cref="LogbirdOptions.ShutdownTimeout"/>. The caller does not wait for the report; the returned
    /// task completes when it is done. A late response is ignored.
    /// </summary>
    internal Task AbandonNow()
    {
        Task dispose;
        try
        {
            dispose = StartDispose();
        }
        catch (Exception e)
        {
            Report(new LogbirdDeliveryException("Logbird shutdown step failed: " + e.GetType().Name));
            return Task.CompletedTask;
        }

        if (dispose.IsCompleted || _queue is null)
        {
            return Task.CompletedTask;
        }

        lock (_disposeGate)
        {
            return _abandonNow ??= Task.Run(() =>
            {
                try
                {
                    // Stop first: cancellation reaches the backoff and the request, so nothing is sent after the report.
                    _stop.Cancel();
                }
                catch (Exception e)
                {
                    Report(new LogbirdDeliveryException("Logbird shutdown step failed: " + e.GetType().Name));
                }

                AbandonRemaining();
            });
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
    /// Stops accepting events and sends what is queued, waiting at most <see cref="LogbirdOptions.ShutdownTimeout"/>, plus
    /// up to 2 seconds for a cancelled request to unwind. Events not yet delivered afterwards, including a batch whose
    /// request has not returned, are then reported as <see cref="DropReason.Shutdown"/> (through
    /// <see cref="LogbirdOptions.OnDrop"/>, best effort), which is in-memory work proportional to the events left; a late
    /// response is then ignored. Finally it waits up to 5 seconds for pending callbacks. Never throws.
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
    /// Shutdown takes ownership of everything not yet delivered, the in-flight batch included, and reports each event exactly
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
                Drop(DropReason.Shutdown, item.Id, item.Action, item.Json, "The shutdown timeout ran out before delivery was confirmed.", mayBeStored: item.MayBeStoredWhenAbandoned);
            }

            foreach (var item in queued)
            {
                Drop(DropReason.Shutdown, item.Id, item.Action, item.Json, "The shutdown timeout ran out before delivery was confirmed.", mayBeStored: item.MayBeStoredWhenAbandoned);
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
                Report(new LogbirdDeliveryException($"{abandoned} audit event(s) were not delivered before shutdown."), log: false);
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
    /// <see cref="LogbirdOptions.ShutdownTimeout"/> plus 10 seconds. Safe on threads with a synchronization context
    /// (WinForms, WPF, classic ASP.NET): the work runs on the thread pool, so it cannot deadlock. If the thread pool is too
    /// busy to finish in time, the remaining events are reported as <see cref="DropReason.Shutdown"/> on the thread pool
    /// after this returns; a process that exits at once may not finish that report.
    /// </summary>
    public void Dispose()
    {
        try
        {
            // The deadline starts on entry and disposal starts (or is joined) on the thread pool, never on this thread: its
            // accounting takes the queue lock and walks the queue. The proxy task returned by Task.Run cannot be inlined by
            // Wait. Past the deadline, taking ownership of the remaining events is handed to the thread pool as well.
            // Admission closes on this thread first, so no event is accepted while disposal waits for the pool.
            _closing = true;
            var dispose = Task.Run(StartDispose);
            if (!dispose.Wait(_shutdownTimeout + TimeSpan.FromSeconds(10)) && _queue is not null)
            {
                _ = Task.Run(AbandonRemaining);
            }
        }
        catch (Exception e)
        {
            Report(new LogbirdDeliveryException("Logbird shutdown step failed: " + e.GetType().Name));
        }
    }

    internal static bool IsInsideDelivery => InsideLogbird.Value;

    private static HttpClient CreateHttpClient() => new(CreateHandler()) { Timeout = Timeout.InfiniteTimeSpan };

    /// <summary>
    /// The handler of a client this SDK creates. It never follows redirects (a redirect would forward the audit body to
    /// another origin; a 3xx is reported as a permanent HTTP error instead) and never uses a proxy (a system or environment
    /// proxy would read the ingest key on an HTTP endpoint, or behind TLS interception). To send through a proxy, pass your own
    /// <see cref="HttpClient"/>.
    /// </summary>
    internal static HttpMessageHandler CreateHandler()
#if NET8_0_OR_GREATER
        => new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5), AllowAutoRedirect = false, UseProxy = false };
#else
        => new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false };
#endif

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

            // Deliveries were counted as each event settled (a flush can complete mid-send, and its caller may read Stats).
            if (!_queue.FinishBatch(result.Failure is null ? [] : result.Unsettled, out _))
            {
                // Shutdown took ownership of this batch and reported it; ignore the late result.
                return false;
            }

            if (result.Failure is { } failure)
            {
                Count(ref _failedSends, ref LogbirdMetrics.FailedSendsTotal);
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
    private void Notify(Action notification, int weight = 1)
        => _notifier.Post(Guarded(notification), weight);

    private static Action Guarded(Action notification) => () =>
    {
        InsideLogbird.Value = true;
        notification();
    };

    /// <summary>
    /// Holds a place for an error report in the notification order before the events it is about settle, so a flush that
    /// sees them settled also waits for the report. The returned callback posts the report, or with null releases the place.
    /// </summary>
    private Action<Exception?> ReserveReport()
    {
        var slot = _notifier.Reserve();
        return error => _notifier.PostReserved(slot, error is null ? null : Guarded(() => ReportCore(error, log: true)));
    }

    /// <summary>
    /// A memory guard, separate from the size limit: data measuring more than 1 MiB (four times the 256 KB wire limit) before
    /// redaction is refused before anything copies it, because copying an unbounded caller tree to redact it could exhaust
    /// memory. The unit is a lower bound of the event's UTF-8 JSON (one byte per UTF-16 code unit of text, plus punctuation
    /// and number digits; see <see cref="JsonSize"/>). Everything below the guard is decided on what is sent.
    /// </summary>
    internal const int MaxDataBytes = 4 * MaxEventBytes;

    /// <summary>The <see cref="DroppedEvent.Detail"/> of an event refused by the memory guard.</summary>
    internal const string GuardDetail = "The event's data exceeds 1 MiB before redaction.";

    /// <summary>The <see cref="DroppedEvent.Detail"/> of an event whose data nests deeper than <see cref="JsonSize.Max"/> levels.</summary>
    internal static readonly string DepthDetail = $"An audit event nests JSON deeper than {JsonSize.Max} levels and was dropped.";

    /// <summary>
    /// Why an event must be refused before anything copies it (depth, then the memory guard, in one iterative walk), or
    /// null when it may be copied. Shared by <see cref="Track"/> and the ASP.NET Core recording path.
    /// </summary>
    internal static (DropReason Reason, string Detail)? RefuseBeforeCopy(AuditEvent auditEvent)
        => JsonSize.Measure(auditEvent, MaxDataBytes) switch
        {
            JsonSize.Shape.TooDeep => (DropReason.Invalid, DepthDetail),
            JsonSize.Shape.TooLarge => (DropReason.TooLarge, GuardDetail),
            _ => null,
        };

    /// <summary>
    /// One iterative walk before anything copies the event: a tree deeper than <see cref="JsonSize.Max"/> levels is dropped
    /// as <see cref="DropReason.Invalid"/> (instead of risking the host's stack), and data beyond the memory guard as
    /// <see cref="DropReason.TooLarge"/>. Both are checked on the event as given, before BeforeSend and redaction: a part
    /// they would remove still counts, because walking it is the risk. Returns true when the event was dropped here.
    /// </summary>
    private bool CheckShape(AuditEvent auditEvent, string? id, string action)
    {
        switch (RefuseBeforeCopy(auditEvent))
        {
            case null:
                return false;
            case { Reason: DropReason.Invalid, Detail: var detail }:
                throw new SdkDropException(detail);
            case { Detail: var detail }:
                Drop(DropReason.TooLarge, id, action, null, detail);
                Report(new LogbirdDeliveryException("An audit event's data exceeds 1 MiB before redaction and was dropped before it was copied."));
                return true;
        }
    }

    /// <summary>Accounts an event evicted from a full queue. Runs under the queue lock: counters and a posted notification only.</summary>
    private void OnEvicted(QueuedEvent item)
    {
        Drop(DropReason.QueueFull, item.Id, item.Action, item.Json, "The queue is full.", mayBeStored: item.MayBeStored);
        LogQueueFull();
    }

    private static string? Bounded(string? value, int max = 256)
        => value is null || value.Length <= max ? value : value.Substring(0, max);

    // The sender counted the drop when it settled the event (under the queue lock); this only notifies.
    // A rejection is the server's answer about this event's content, which an earlier request would have met too: it was
    // not stored. Two codes say nothing about content: stored_event_unreadable (something with this id is stored and cannot
    // be compared) and unverified_after_parse_failure (this request was not checked). For them an earlier lost answer
    // keeps the outcome unknown.
    // Prepared before the event settles and posted inside the settlement (BatchSender.State.TryReject).
    private Action? OnSenderDrop(QueuedEvent item, DropReason reason, string? detail, string? code)
        => PrepareDrop(reason, item.Id, item.Action, item.Json, detail, code, reason switch
        {
            DropReason.Rejected => code is "stored_event_unreadable" or "unverified_after_parse_failure" && item.AnswerLost,
            _ => item.MayBeStored,
        });

    /// <summary>
    /// Counts skipped notifications, and the first time any is skipped says so once through the logger and
    /// <see cref="LogbirdOptions.OnError"/>, so an operator who never reads the meter still learns that per-event
    /// callbacks are being lost. That one report bypasses the full notification queue: it runs on the thread pool itself.
    /// </summary>
    private void OnNotificationsLost(int lost)
    {
        Count(ref _notificationsLost, ref LogbirdMetrics.NotificationsLostTotal, lost);
        if (Interlocked.Exchange(ref _lostReported, 1) != 0)
        {
            return;
        }

        var notice = new LogbirdDeliveryException(
            "Logbird skipped OnDrop/OnError notifications because the callbacks fell behind; every skipped one is counted on "
            + "logbird.notifications.lost. Events are still counted in Stats. This is reported once.");
        bool queued;
        try
        {
            queued = ScheduleNotice(_ =>
            {
                InsideLogbird.Value = true;
                ReportCore(notice, log: true);
            });
        }
        catch
        {
            queued = false;
        }

        if (!queued)
        {
            // The notice never ran: the next skipped notification tries again (the counter above recorded this one).
            Interlocked.Exchange(ref _lostReported, 0);
        }
    }

    /// <summary>Queues the one-time loss notice on the thread pool; a test replaces it to refuse, throw or run it later.</summary>
    internal Func<WaitCallback, bool> ScheduleNotice { get; set; } = callback => ThreadPool.UnsafeQueueUserWorkItem(callback, null);

    // A server reason can quote the event's values; the message and log line keep only its leading field or code.
    private void OnSenderWarning(QueuedEvent item, string reason)
        => Warn(item.Id, item.Action, reason, "Logbird warning about a stored event: server warning (" + SafePrefix(reason) + ")");

    // A server reason is free text that can quote the event's values; the summary names only a fixed topic.
    private static string SafePrefix(string reason)
        => reason.Contains("occurredAt") ? "occurredAt"
            : reason.Contains("whitespace") || reason.Contains("Whitespace") ? "identifier whitespace"
            : reason.Contains("id") ? "id"
            : "other";

    private void Warn(string id, string action, string reason, string message)
    {
        Count(ref _warnings, ref LogbirdMetrics.WarningsTotal);
        Report(new LogbirdEventWarning(id, action, reason, message));
    }

    /// <summary>
    /// The SDK's identifier warnings about one event: counted each now, delivered in inspection order as a single
    /// notification, and formatted only then.
    /// </summary>
    private void WarnAll(string id, string action, EntityIds.Warning[] warnings)
    {
        Count(ref _warnings, ref LogbirdMetrics.WarningsTotal, warnings.Length);

        // One queue entry carrying one OnError call per warning: if it is skipped, every one of them counts as lost.
        Notify(weight: warnings.Length, notification: () =>
        {
            foreach (var warning in warnings)
            {
                var reason = EntityIds.Describe(warning);
                ReportCore(new LogbirdEventWarning(id, action, reason, "Logbird warning about an event it is sending: " + reason), log: true);
            }
        });
    }

    /// <summary>Counts on this client's Stats and on the process-wide totals the meters read.</summary>
    private static void Count(ref long own, ref long total, long amount = 1)
    {
        Interlocked.Add(ref own, amount);
        Interlocked.Add(ref total, amount);
    }

    internal long NotificationsLost => Interlocked.Read(ref _notificationsLost);

    internal long CallbackFailures => Interlocked.Read(ref _callbackFailures);


    /// <summary>Counts a drop (counters only, so it can run under the queue lock).</summary>
    private void CountDrop(DropReason reason)
    {
        if ((int)reason >= 0 && (int)reason < LogbirdMetrics.DroppedTotals.Length)
        {
            Interlocked.Increment(ref LogbirdMetrics.DroppedTotals[(int)reason]);
        }

        if (reason == DropReason.Rejected)
        {
            Count(ref _rejected, ref LogbirdMetrics.RejectedTotal);
        }
        else
        {
            Interlocked.Increment(ref _dropped);
        }
    }

    private void Drop(DropReason reason, string? id, string action, byte[]? json, string? detail, string? code = null, bool mayBeStored = false)
    {
        CountDrop(reason);
        PrepareDrop(reason, id, action, json, detail, code, mayBeStored)?.Invoke();
    }

    /// <summary>The <c>OnDrop</c> report for one dropped event, ready to post; null when no <c>OnDrop</c> is set.</summary>
    private Action? PrepareDrop(DropReason reason, string? id, string action, byte[]? json, string? detail, string? code, bool mayBeStored)
    {
        if (_onDrop is not { } onDrop)
        {
            return null;
        }

        // Display fields are bounded (an oversized action or id must not be kept whole in the backlog); the JSON, when
        // kept, carries the event for replay.
        var dropped = new DroppedEvent(reason, Bounded(id), Bounded(action)!, json, Bounded(detail, 1_024), code, mayBeStored);
        return () => Notify(() => onDrop(dropped));
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
                Count(ref _callbackFailures, ref LogbirdMetrics.CallbackFailuresTotal);
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
            Count(ref _callbackFailures, ref LogbirdMetrics.CallbackFailuresTotal);
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

    [LoggerMessage(EventId = 4, Level = LogLevel.Error, Message = "Logbird shut down with {Count} undelivered audit event(s)")]
    private static partial void LogShutdownDropped(ILogger logger, int count);

    /// <summary>A drop the SDK itself decided; its message is SDK-owned and safe to forward as it is.</summary>
    private sealed class SdkDropException(string message) : LogbirdDeliveryException(message);
}
