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
    private readonly EventQueue? _queue;
    private readonly BatchSender? _sender;
    private readonly HttpClient? _ownedHttp;
    private readonly SemaphoreSlim _signal = new(0);
    private readonly CancellationTokenSource _stop = new();
    private readonly List<(long Target, TaskCompletionSource<bool> Completion)> _waiters = [];
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly Task? _loop;

    private int _signaled;
    private int _disposed;
    private volatile bool _closing;
    private volatile bool _flushRequested;
    private volatile int _inFlight;
    private long _firstQueuedAtTicks;
    private long _retryAtTicks;
    private int _consecutiveFailures;
    private long _lastQueueFullLogTicks = long.MinValue;

    private long _tracked;
    private long _delivered;
    private long _rejected;
    private long _dropped;
    private long _filtered;
    private long _failedSends;

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
        if (!_enabled)
        {
            return;
        }

        var http = httpClient ?? (_ownedHttp = CreateHttpClient());
        _queue = new EventQueue(options.MaxQueueSize, options.QueueFullBehavior);
        _sender = new BatchSender(http, options.Endpoint!, options.IngestKey!, options.MaxRetries, OnSenderDrop, Report, delay);
        _loop = Task.Run(RunAsync);
    }

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
        (_queue?.Count ?? 0) + _inFlight);

    /// <summary>
    /// Creates a new event id (a UUIDv7, sortable by time). Use it when you store an event before sending it, so a
    /// replay keeps the same id and Logbird keeps one copy.
    /// </summary>
    public static string NewEventId() => UuidV7.NewId();

    /// <inheritdoc />
    public void Track(AuditEvent auditEvent)
    {
        if (!_enabled)
        {
            return;
        }

        if (InsideLogbird.Value)
        {
            Interlocked.Increment(ref _filtered);
            return;
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
                return;
            }

            var source = auditEvent!;
            id = source.Id ?? UuidV7.NewId();
            var occurredAt = source.OccurredAt ?? DateTimeOffset.UtcNow;
            if (_beforeSend is not null)
            {
                var copy = source.Clone();
                copy.Id = id;
                copy.OccurredAt = occurredAt;
                copy.Environment ??= _environment;
                copy.Source ??= _source;
                var result = _beforeSend(copy);
                if (result is null)
                {
                    Interlocked.Increment(ref _filtered);
                    return;
                }

                source = result;
                action = source.Action ?? string.Empty;
                id = source.Id;
                occurredAt = source.OccurredAt ?? occurredAt;
            }

            // The server mints a fresh id for a missing or blank id, which a retry could never match. Mint it here instead.
            if (id is null || EventJson.JsTrim(id).Length == 0)
            {
                id = UuidV7.NewId();
            }

            var node = EventJson.ToJsonObject(source, id, occurredAt, _environment, _source);
            _redactor?.RedactInPlace(node);
            json = EventJson.ToUtf8(node);
            if (json.Length > MaxEventBytes)
            {
                Drop(DropReason.TooLarge, id, action, json, "The event exceeds 256 KB.");
                Report(new LogbirdDeliveryException("An audit event exceeds 256 KB and was dropped."));
                return;
            }

            var eventId = id;
            var eventJson = json;
            var eventAction = action;
            var overflow = _queue!.Enqueue(sequence => new QueuedEvent(eventJson, eventId, eventAction, sequence), out var added, out var count);
            if (added is not null)
            {
                Interlocked.Increment(ref _tracked);
                LogbirdMetrics.Tracked.Add(1);
                LogbirdMetrics.QueueLength.Add(1);
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

            if (added is not null && _loop!.IsCompleted)
            {
                // Shutdown finished between the closing check and the enqueue: report instead of stranding the event.
                foreach (var item in _queue.Clear())
                {
                    LogbirdMetrics.QueueLength.Add(-1);
                    Drop(DropReason.Shutdown, item.Id, item.Action, item.Json, "The client is shut down.");
                }
            }

            if (overflow is not null)
            {
                if (added is not null)
                {
                    LogbirdMetrics.QueueLength.Add(-1);
                }

                Drop(DropReason.QueueFull, overflow.Id, overflow.Action, overflow.Json, "The queue is full.");
                LogQueueFull();
            }
        }
        catch (Exception e)
        {
            Drop(DropReason.Invalid, id, action, json, e.GetType().Name);
            Report(e is LogbirdDeliveryException ? e : new LogbirdDeliveryException("An audit event could not be recorded: " + e.GetType().Name, e));
        }
        finally
        {
            InsideLogbird.Value = false;
        }
    }

    /// <inheritdoc />
    public async Task<bool> FlushAsync(CancellationToken cancellationToken = default)
    {
        if (!_enabled || _queue is null)
        {
            return true;
        }

        try
        {
            if (Volatile.Read(ref _disposed) == 1 && _loop!.IsCompleted)
            {
                return _queue.Count == 0;
            }

            var target = _queue.LastSequence;
            if (_inFlight == 0 && _queue.Count == 0)
            {
                return true;
            }

            var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (_waiters)
            {
                _waiters.Add((target, completion));
            }

            _flushRequested = true;
            Signal();
            if (_loop!.IsCompleted)
            {
                CompleteWaiters(_ => true, _queue.Count == 0);
            }

            using (cancellationToken.Register(() => completion.TrySetResult(false)))
            {
                return await completion.Task.ConfigureAwait(false);
            }
        }
        catch (Exception e)
        {
            Report(e);
            return false;
        }
    }

    /// <summary>
    /// Stops accepting events and sends what is queued, waiting at most <see cref="LogbirdOptions.ShutdownTimeout"/>.
    /// Events still queued afterwards are reported through <see cref="LogbirdOptions.OnDrop"/>. Never throws.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1)
        {
            return;
        }

        try
        {
            if (_loop is not null)
            {
                _closing = true;
                Signal();
                var finished = await Task.WhenAny(_loop, Task.Delay(_shutdownTimeout)).ConfigureAwait(false) == _loop;
                if (!finished)
                {
                    _stop.Cancel();
                    await Task.WhenAny(_loop, Task.Delay(TimeSpan.FromSeconds(2))).ConfigureAwait(false);
                }

                var left = _queue!.Clear();
                foreach (var item in left)
                {
                    LogbirdMetrics.QueueLength.Add(-1);
                    Drop(DropReason.Shutdown, item.Id, item.Action, item.Json, "The shutdown timeout ran out before the event was sent.");
                }

                if (left.Count > 0)
                {
                    LogShutdownDropped(_logger, left.Count);
                    Report(new LogbirdDeliveryException($"{left.Count} audit event(s) were not sent before shutdown."));
                }

                CompleteWaiters(_ => true, false);
            }
        }
        catch (Exception e)
        {
            Report(e);
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
    public void Dispose() => Task.Run(() => DisposeAsync().AsTask()).GetAwaiter().GetResult();

    private static HttpClient CreateHttpClient()
    {
#if NET8_0_OR_GREATER
        var handler = new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) };
#else
        var handler = new HttpClientHandler();
#endif
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
                Report(e);
                await Task.Delay(_flushInterval).ConfigureAwait(false);
            }
        }

        CompleteWaiters(_ => true, _queue!.Count == 0);
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

            _inFlight = 1;
            var batch = _queue!.TakeBatch(_batchSize, MaxBatchBytes);
            if (batch.Length == 0)
            {
                _inFlight = 0;
                break;
            }

            _inFlight = batch.Length;
            LogbirdMetrics.QueueLength.Add(-batch.Length);
            SendResult result;
            try
            {
                result = await _sender!.SendAsync(batch, _stop.Token).ConfigureAwait(false);
            }
            catch (Exception e)
            {
                // Defensive: never lose a batch to an unexpected error; put all of it back.
                result = new SendResult([.. batch], new LogbirdDeliveryException("Logbird delivery failed unexpectedly: " + e.GetType().Name, e), 0);
            }
            if (result.Delivered > 0)
            {
                Interlocked.Add(ref _delivered, result.Delivered);
                LogbirdMetrics.Delivered.Add(result.Delivered);
            }

            if (result.Failure is { } failure)
            {
                var overflow = _queue.RequeueFront(result.Unsettled);
                LogbirdMetrics.QueueLength.Add(result.Unsettled.Count - overflow.Count);
                _inFlight = 0;
                foreach (var item in overflow)
                {
                    Drop(DropReason.QueueFull, item.Id, item.Action, item.Json, "The queue is full.");
                }

                Interlocked.Increment(ref _failedSends);
                LogbirdMetrics.FailedSends.Add(1);
                _consecutiveFailures++;
                var backoff = TimeSpan.FromSeconds(Math.Min(60, Math.Pow(2, Math.Min(_consecutiveFailures - 1, 6))));
                if (backoff < _flushInterval)
                {
                    backoff = _flushInterval;
                }

                var now = _clock.Elapsed.Ticks;
                Interlocked.Exchange(ref _retryAtTicks, now + backoff.Ticks);
                Interlocked.Exchange(ref _firstQueuedAtTicks, now);
                LogDeliveryFailed(_logger, result.Unsettled.Count, backoff.TotalSeconds, failure);
                Report(failure, log: false);
                CompleteWaiters(_ => true, false);
                return false;
            }

            _inFlight = 0;
            _consecutiveFailures = 0;
            Interlocked.Exchange(ref _retryAtTicks, 0);
            var head = _queue.HeadSequence;
            CompleteWaiters(target => target < head, true);
        }

        var remaining = _queue!.HeadSequence;
        CompleteWaiters(target => target < remaining, true);
        if (remaining == long.MaxValue)
        {
            Interlocked.Exchange(ref _firstQueuedAtTicks, _clock.Elapsed.Ticks);
        }

        return true;
    }

    private void CompleteWaiters(Func<long, bool> predicate, bool result)
    {
        List<TaskCompletionSource<bool>>? done = null;
        lock (_waiters)
        {
            for (var i = _waiters.Count - 1; i >= 0; i--)
            {
                if (predicate(_waiters[i].Target))
                {
                    (done ??= []).Add(_waiters[i].Completion);
                    _waiters.RemoveAt(i);
                }
            }
        }

        if (done is not null)
        {
            foreach (var completion in done)
            {
                completion.TrySetResult(result);
            }
        }
    }

    private void OnSenderDrop(QueuedEvent item, DropReason reason, string? detail)
        => Drop(reason, item.Id, item.Action, item.Json, detail);

    private void Drop(DropReason reason, string? id, string action, byte[]? json, string? detail)
    {
        if (reason == DropReason.Rejected)
        {
            Interlocked.Increment(ref _rejected);
            LogbirdMetrics.Rejected.Add(1);
        }
        else
        {
            Interlocked.Increment(ref _dropped);
            LogbirdMetrics.Dropped.Add(1, LogbirdMetrics.Reason(reason));
        }

        if (_onDrop is null)
        {
            return;
        }

        var outer = InsideLogbird.Value;
        InsideLogbird.Value = true;
        try
        {
            _onDrop(new DroppedEvent(reason, id, action, json, detail));
        }
        catch
        {
            // A diagnostic hook must never break capture.
        }
        finally
        {
            InsideLogbird.Value = outer;
        }
    }

    private void Report(Exception error) => Report(error, log: true);

    private void Report(Exception error, bool log)
    {
        var outer = InsideLogbird.Value;
        InsideLogbird.Value = true;
        try
        {
            ReportCore(error, log);
        }
        finally
        {
            InsideLogbird.Value = outer;
        }
    }

    private void ReportCore(Exception error, bool log)
    {
        if (log)
        {
            try
            {
                LogError(_logger, error.Message, error is LogbirdDeliveryException ? null : error);
            }
            catch
            {
                // Logging must never break capture.
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
            // A diagnostic hook must never break capture.
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

        try
        {
            LogQueueFullWarning(_logger, Interlocked.Read(ref _dropped));
        }
        catch
        {
            // Logging must never break capture.
        }
    }

    [LoggerMessage(EventId = 1, Level = LogLevel.Warning, Message = "Logbird: {Message}")]
    private static partial void LogError(ILogger logger, string message, Exception? exception);

    [LoggerMessage(EventId = 2, Level = LogLevel.Warning, Message = "Logbird delivery failed; {Count} event(s) kept in the queue, next attempt in {DelaySeconds} s")]
    private static partial void LogDeliveryFailed(ILogger logger, int count, double delaySeconds, Exception exception);

    [LoggerMessage(EventId = 3, Level = LogLevel.Warning, Message = "Logbird queue is full; audit events are being dropped ({Dropped} dropped so far)")]
    private static partial void LogQueueFullWarning(ILogger logger, long dropped);

    [LoggerMessage(EventId = 4, Level = LogLevel.Error, Message = "Logbird shut down with {Count} unsent audit event(s)")]
    private static partial void LogShutdownDropped(ILogger logger, int count);
}
