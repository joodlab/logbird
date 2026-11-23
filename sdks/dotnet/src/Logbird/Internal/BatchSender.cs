using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Internal;

/// <summary>What happened to one batch.</summary>
internal sealed class SendResult(List<QueuedEvent> unsettled, Exception? failure, int delivered)
{
    /// <summary>Events neither stored nor permanently rejected or dropped; requeue them when <see cref="Failure"/> is set.</summary>
    public List<QueuedEvent> Unsettled { get; } = unsettled;

    /// <summary>Set when the batch failed after retries (or the time limit, or shutdown).</summary>
    public Exception? Failure { get; } = failure;

    public int Delivered { get; } = delivered;
}

/// <summary>
/// Sends one batch with the same retry protocol as the TypeScript SDK (packages/sdk/src/index.ts, after #150):
/// identical bodies on retry, <c>Logbird-Retry: subset</c>, per-event rejections on 202 and 503, subset resends after
/// complete 503 details, Retry-After, exponential backoff with jitter, and a five-minute cap per batch.
/// </summary>
internal sealed class BatchSender
{
    // Must equal @logbird/contracts LOGBIRD_RETRY_HEADER / LOGBIRD_RETRY_SUBSET.
    internal const string RetryHeader = "Logbird-Retry";
    internal const string RetrySubset = "subset";
    internal static readonly TimeSpan MaxSendTime = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan MaxCancelGrace = TimeSpan.FromSeconds(2);

    /// <summary>Requests abandoned after their deadline that have not returned yet; new attempts wait while this is reached.</summary>
    internal const int MaxAbandonedAttempts = 4;

    private readonly HttpClient _http;
    private readonly Uri _eventsUri;
    private readonly AuthenticationHeaderValue _authorization;
    private readonly int _maxRetries;
    private readonly TimeSpan _requestTimeout;
    // Prepares an event's drop report (null when nobody listens); it is posted inside the settlement, see State.TryReject.
    private readonly Func<QueuedEvent, DropReason, string?, string?, Action?> _drop;
    private readonly Action<QueuedEvent, string> _warn;
    private readonly Action _progress;

    // Settling, counting and posting the drop report happen together (under the queue lock, see EventQueue.Settle), so a
    // flush that sees an event settled also sees it counted and finds its report already posted.
    private readonly Action? _delivered;
    private readonly Action<DropReason>? _countDrop;
    private readonly Func<QueuedEvent, Action, bool> _settle;
    private int _abandonedAttempts;
    private readonly Action<Exception> _report;

    // Reserves the place of a batch-level OnError report before the events it is about settle, so no flush can see them
    // settled and return before the report is posted; the returned callback posts it (or releases the place with null).
    private readonly Func<Action<Exception?>> _reserveReport;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly Func<double> _random;
    private readonly Func<TimeSpan> _elapsed;

    public BatchSender(
        HttpClient http,
        Uri endpoint,
        string ingestKey,
        int maxRetries,
        TimeSpan requestTimeout,
        Func<QueuedEvent, DropReason, string?, string?, Action?> drop,
        Action<QueuedEvent, string> warn,
        Action progress,
        Action<Exception> report,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        Func<double>? random = null,
        Func<TimeSpan>? clock = null,
        Action? delivered = null,
        Action<DropReason>? countDrop = null,
        Func<QueuedEvent, Action, bool>? settle = null,
        Func<Action<Exception?>>? reserveReport = null)
    {
        _delivered = delivered;
        _countDrop = countDrop;
        _settle = settle ?? ((item, count) =>
        {
            if (!item.TrySettle())
            {
                return false;
            }

            count();
            return true;
        });
        _http = http;
        _eventsUri = EventsUri(endpoint);
        _authorization = new AuthenticationHeaderValue("Bearer", ingestKey);
        _maxRetries = maxRetries;
        _requestTimeout = requestTimeout;
        _drop = drop;
        _warn = warn;
        _progress = progress;
        _report = report;
        _reserveReport = reserveReport ?? (() => error =>
        {
            if (error is not null)
            {
                report(error);
            }
        });
        _delay = delay ?? Task.Delay;
        var jitter = new Random();
        _random = random ?? (() =>
        {
            lock (jitter)
            {
                return jitter.NextDouble();
            }
        });
        if (clock is null)
        {
            var started = Stopwatch.StartNew();
            _elapsed = () => started.Elapsed;
        }
        else
        {
            _elapsed = clock;
        }
    }

    internal static Uri EventsUri(Uri endpoint) => Endpoints.Append(endpoint, "/v1/events");

    public async Task<SendResult> SendAsync(QueuedEvent[] batch, CancellationToken stop)
    {
        var state = new State(batch, _settle, _delivered, _countDrop);
        try
        {
            return await SendCoreAsync(state, stop).ConfigureAwait(false);
        }
        catch (Exception e)
        {
            // Never lose settlement already recorded: only still-pending events go back to the queue.
            return state.Fail(new LogbirdDeliveryException("Logbird delivery failed unexpectedly: " + e.GetType().Name));
        }
    }

    private async Task<SendResult> SendCoreAsync(State state, CancellationToken stop)
    {
        var batch = state.Batch;

        // Monotonic: a wall-clock step (NTP, suspend) must not shorten or extend the cap.
        var deadline = _elapsed() + MaxSendTime;
        var attempt = Enumerable.Range(0, batch.Length).ToArray();
        var body = EventJson.BuildBatchBody(batch, attempt);
        var retries = 0;
        for (long attemptNumber = 0; ; attemptNumber++)
        {
            var remaining = deadline - _elapsed();
            if (remaining <= TimeSpan.Zero)
            {
                return state.Fail(new LogbirdDeliveryException("Logbird send exceeded its five-minute time limit."));
            }

            // Shutdown took ownership of these events and reported them; sending them now would contradict the report.
            if (stop.IsCancellationRequested || Array.TrueForAll(attempt, index => batch[index].IsAbandoned))
            {
                return state.Fail(new LogbirdDeliveryException("Logbird delivery was stopped by shutdown."));
            }

            var progressed = false;
            var unacknowledged = false;
            HttpResponseMessage? response;
            byte[]? responseBody;
            Exception? error;
            var headersStatus = new StrongBox<int>();
            var dispatched = false;
            Dictionary<int, int>? dispatchNumbers = null;
            if (Volatile.Read(ref _abandonedAttempts) >= MaxAbandonedAttempts)
            {
                // Earlier requests are still stuck in the handler: do not pile up more, and do not dispatch these events,
                // so they keep whatever the wire already knows about them. Treated like a network error.
                (response, responseBody, error) = (null, null, new TimeoutException("Earlier Logbird requests have not returned; waiting before sending again."));
            }
            else
            {
                // From here the server may store these events, whatever happens to its answer. An event shutdown already
                // took is left out of the request, so its report stays true.
                var dispatchList = new List<int>(attempt.Length);
                var numberList = new List<int>(attempt.Length);
                foreach (var index in attempt)
                {
                    if (batch[index].TryStartDispatch(out var number))
                    {
                        dispatchList.Add(index);
                        numberList.Add(number);
                    }
                }

                if (dispatchList.Count == 0)
                {
                    return state.Fail(new LogbirdDeliveryException("Logbird delivery was stopped by shutdown."));
                }

                if (dispatchList.Count < attempt.Length)
                {
                    attempt = dispatchList.ToArray();
                    body = EventJson.BuildBatchBody(batch, attempt);
                }

                // Each answer quotes the dispatch numbers of its own request, so a late answer to an older request can
                // never clear the flag a newer request set.
                dispatchNumbers = new Dictionary<int, int>(dispatchList.Count);
                for (var i = 0; i < dispatchList.Count; i++)
                {
                    dispatchNumbers[dispatchList[i]] = numberList[i];
                }

                dispatched = true;

                // A 4xx counts the moment its headers arrive, before the body is read: shutdown can take the events while
                // the body is still coming, and must then see that the server did not store them.
                var carried = dispatchNumbers;
                void OnHeaders(int status)
                {
                    if (status is >= 400 and < 500)
                    {
                        foreach (var entry in carried)
                        {
                            if (!state.IsSettled(entry.Key))
                            {
                                batch[entry.Key].OnNotStored(entry.Value);
                            }
                        }
                    }
                }

                (response, responseBody, error) = await AttemptAsync(body, remaining < _requestTimeout ? remaining : _requestTimeout, headersStatus, OnHeaders, stop).ConfigureAwait(false);
            }

            // The status counts as soon as the headers arrived, even when the body could not be read afterwards.
            var answeredStatus = response is null ? headersStatus.Value : (int)response.StatusCode;

            using (response)
            {
                if (stop.IsCancellationRequested)
                {
                    // Nothing below runs; record what this answer said about the events it carried.
                    if (dispatched)
                    {
                        RecordAnswer(state, attempt, answeredStatus, dispatchNumbers!);
                    }

                    return state.Fail(new LogbirdDeliveryException("Logbird delivery was stopped by shutdown."));
                }

                // A permanent answer (a redirect, or a 4xx other than 429) stays permanent when its body could not be read:
                // the headers already decided it. Any other unread answer is handled as no answer (0) and retried, which is
                // safe: the server keeps one copy per id.
                var status = response is not null ? (int)response.StatusCode
                    : answeredStatus is >= 300 and < 500 and not 429 ? answeredStatus
                    : 0;
                if (status is >= 200 and < 300)
                {
                    // A success counts only for events the response acknowledges: rejected by index, or accepted by id. A
                    // proxy or gateway answering 2xx without forwarding must never make events count as delivered.
                    if (TryParse(responseBody, out var document))
                    {
                        using (document)
                        {
                            var root = document.RootElement;
                            if (root.ValueKind == JsonValueKind.Object
                                && root.TryGetProperty("accepted", out var acceptedCount) && acceptedCount.ValueKind == JsonValueKind.Number
                                && root.TryGetProperty("ids", out var ids) && ids.ValueKind == JsonValueKind.Array)
                            {
                                if (root.TryGetProperty("rejected", out var rejected))
                                {
                                    Reject(state, attempt, rejected);
                                }

                                if (root.TryGetProperty("warnings", out var warnings))
                                {
                                    Warn(state, attempt, warnings, unresolved: null);
                                }

                                // Each accepted id acknowledges one entry: two entries with the same id need two.
                                var acknowledged = new Dictionary<string, int>(StringComparer.Ordinal);
                                foreach (var acceptedId in ids.EnumerateArray())
                                {
                                    if (acceptedId.ValueKind == JsonValueKind.String)
                                    {
                                        var key = Text(acceptedId);
                                        acknowledged[key] = acknowledged.TryGetValue(key, out var times) ? times + 1 : 1;
                                    }
                                }

                                Credit(state, attempt, acknowledged, wire => true);
                            }
                        }
                    }

                    var left = attempt.Where(index => !state.IsSettled(index)).ToArray();
                    if (left.Length == 0)
                    {
                        return state.Complete();
                    }

                    // Resend only the unacknowledged events, byte-identical; the server keeps one copy per id.
                    unacknowledged = true;
                    progressed = left.Length < attempt.Length;
                    if (progressed)
                    {
                        attempt = left;
                        body = EventJson.BuildBatchBody(batch, attempt);
                    }
                }

                if (status == 503 && TryParse(responseBody, out var errorDocument))
                {
                    using (errorDocument)
                    {
                        var root = errorDocument.RootElement;
                        if (root.ValueKind == JsonValueKind.Object
                            && root.TryGetProperty("error", out var errorElement)
                            && errorElement.ValueKind == JsonValueKind.Object
                            && errorElement.TryGetProperty("code", out var code)
                            && code.ValueKind == JsonValueKind.String
                            && Text(code) is "ingest_pending" or "ingest_unavailable")
                        {
                            var hasDetails = errorElement.TryGetProperty("details", out var details) && details.ValueKind == JsonValueKind.Object;
                            if (hasDetails && details.TryGetProperty("rejected", out var detailRejected))
                            {
                                Reject(state, attempt, detailRejected);
                                _progress();
                            }

                            if (hasDetails && CompleteDetails(batch, attempt, details, out var acceptedIds, out var unresolved))
                            {
                                Warn(state, attempt, details.GetProperty("warnings"), unresolved);

                                // Each accepted id settles one entry; a second entry with the same id stays unaccounted,
                                // which makes the details incomplete and keeps the previous body.
                                Credit(state, attempt, acceptedIds, wire => !unresolved.Contains(wire));

                                // Every omitted position must be settled; otherwise malformed details keep the previous body.
                                var allAccounted = true;
                                for (var wire = 0; wire < attempt.Length; wire++)
                                {
                                    if (!unresolved.Contains(wire) && !state.IsSettled(attempt[wire]))
                                    {
                                        allAccounted = false;
                                        break;
                                    }
                                }

                                // Flushes whose events this response settled need not wait for the rest of the batch.
                                _progress();

                                if (allAccounted)
                                {
                                    var left = attempt.Where(index => !state.IsSettled(index)).ToArray();
                                    if (left.Length == 0)
                                    {
                                        return state.Complete();
                                    }

                                    if (left.Length < attempt.Length)
                                    {
                                        attempt = left;
                                        body = EventJson.BuildBatchBody(batch, attempt);
                                        progressed = true;
                                    }
                                }
                            }
                        }
                    }
                }

                if (dispatched)
                {
                    RecordAnswer(state, attempt, answeredStatus, dispatchNumbers!);
                }

                var retryable = status == 0 || status == 429 || status >= 500 || unacknowledged;
                if (!retryable)
                {
                    var post = _reserveReport();
                    try
                    {
                        foreach (var index in state.PendingIndices())
                        {
                            state.TryReject(index, DropReason.HttpError, _drop(batch[index], DropReason.HttpError, "HTTP " + status.ToString(CultureInfo.InvariantCulture), null));
                        }
                    }
                    finally
                    {
                        post(new LogbirdDeliveryException($"Logbird HTTP {status}; batch dropped.", (HttpStatusCode)status));
                    }

                    return state.Complete();
                }

                // Progress attempts strictly shrink the body, so there can be at most batch.Length of them. Only
                // non-progress failures consume MaxRetries; a hard total-attempt bound is kept as well.
                // Wide arithmetic: a very large MaxRetries must not overflow the bound into a negative number.
                if ((!progressed && retries >= _maxRetries) || attemptNumber >= (long)batch.Length + _maxRetries - 1)
                {
                    if (unacknowledged)
                    {
                        // Never counted as delivered: report each event that is still unacknowledged.
                        var count = 0;
                        var post = _reserveReport();
                        try
                        {
                            foreach (var index in state.PendingIndices())
                            {
                                if (state.TryReject(index, DropReason.Unacknowledged, _drop(batch[index], DropReason.Unacknowledged, "The server answered HTTP " + status.ToString(CultureInfo.InvariantCulture) + " without acknowledging the event.", null)))
                                {
                                    count++;
                                }
                            }
                        }
                        finally
                        {
                            post(count > 0 ? new LogbirdDeliveryException($"Logbird HTTP {status} did not acknowledge {count} event(s) after retries; they were dropped.", (HttpStatusCode)status) : null);
                        }

                        return state.Complete();
                    }

                    return state.Fail(error is null
                        ? new LogbirdDeliveryException($"Logbird HTTP {status}", (HttpStatusCode)status)
                        : new LogbirdDeliveryException("Logbird could not be reached: " + error.GetType().Name));
                }

                var delay = RetryAfter(response) ?? (Math.Min(30_000, 250 * Math.Pow(2, retries)) * (0.5 + _random()));
                if (!progressed)
                {
                    retries++;
                }

                var wait = Math.Max(0, Math.Min(Math.Min(60_000, delay), (deadline - _elapsed()).TotalMilliseconds));
                try
                {
                    await _delay(TimeSpan.FromMilliseconds(wait), stop).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return state.Fail(new LogbirdDeliveryException("Logbird delivery was stopped by shutdown."));
                }
            }
        }
    }

    /// <summary>
    /// One HTTP attempt, bounded even when a handler ignores cancellation: after the limit the request is cancelled on
    /// the thread pool (a throwing or blocking cancellation callback cannot stall the sender), and after a short grace
    /// the attempt is abandoned and treated like a network error. A late response is then disposed unread, which is
    /// safe because the retry resends identical bytes.
    /// </summary>
    /// <summary>
    /// Records what an answer said about the dispatched events it did not settle: a 4xx (429 included) says they were not
    /// stored; anything else (no answer, a 5xx, a redirect, a 2xx that did not acknowledge them) leaves the outcome unknown
    /// for good.
    /// </summary>
    private static void RecordAnswer(State state, int[] attempt, int status, Dictionary<int, int> dispatchNumbers)
    {
        foreach (var index in attempt)
        {
            if (state.IsSettled(index) || !dispatchNumbers.TryGetValue(index, out var dispatch))
            {
                continue;
            }

            if (status is >= 400 and < 500)
            {
                state.Batch[index].OnNotStored(dispatch);
            }
            else
            {
                state.Batch[index].OnAnswerLost();
            }
        }
    }

    private async Task<(HttpResponseMessage? Response, byte[]? Body, Exception? Error)> AttemptAsync(byte[] body, TimeSpan limit, StrongBox<int> headersStatus, Action<int> onHeaders, CancellationToken stop)
    {
        var cancellation = CancellationTokenSource.CreateLinkedTokenSource(stop);

        // Dispatch on the thread pool: a handler that blocks before returning its task cannot hold the deadline below.
        var send = Task.Run(() => SendOnceAsync(body, headersStatus, onHeaders, cancellation.Token), CancellationToken.None);
        // The deadline timer is cancelled as soon as the attempt finishes, so a fast answer does not leave it running.
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop);
        var timer = Task.Delay(limit, deadline.Token);
        var first = await Task.WhenAny(send, timer).ConfigureAwait(false);
        deadline.Cancel();
        if (first != send)
        {
            _ = Task.Run(() =>
            {
                try
                {
                    cancellation.Cancel();
                }
                catch
                {
                    // A handler's cancellation callback failed; the attempt is bounded below regardless.
                }
            }, CancellationToken.None);
            var grace = limit < MaxCancelGrace ? limit : MaxCancelGrace;
            if (await Task.WhenAny(send, Task.Delay(grace, CancellationToken.None)).ConfigureAwait(false) != send)
            {
                Interlocked.Increment(ref _abandonedAttempts);
                _ = send.ContinueWith(
                    late =>
                    {
                        Interlocked.Decrement(ref _abandonedAttempts);
                        if (late.Status == TaskStatus.RanToCompletion)
                        {
                            late.Result.Response.Dispose();
                        }

                        _ = late.Exception;
                        cancellation.Dispose();
                    },
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
                return (null, null, new TimeoutException("The Logbird request did not finish within RequestTimeout."));
            }
        }

        try
        {
            var (response, responseBody) = await send.ConfigureAwait(false);
            return (response, responseBody, null);
        }
        catch (Exception e)
        {
            // Any transport failure, including one thrown by a custom handler in the pipeline, is retryable.
            return (null, null, e);
        }
        finally
        {
            cancellation.Dispose();
        }
    }

    private async Task<(HttpResponseMessage Response, byte[] Body)> SendOnceAsync(byte[] body, StrongBox<int> headersStatus, Action<int> onHeaders, CancellationToken cancellationToken)
    {
        using var request = CreateRequest(body);
        var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        Volatile.Write(ref headersStatus.Value, (int)response.StatusCode);
        onHeaders((int)response.StatusCode);
        try
        {
            return (response, await ReadBodyAsync(response, MaxResponseBytes, cancellationToken).ConfigureAwait(false));
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }

    /// <summary>The largest ingest response read (a 1000-event answer is far smaller); a larger one is treated as a failure.</summary>
    internal const int MaxResponseBytes = 4 * 1024 * 1024;

    /// <summary>
    /// Reads a response body under a size cap. Cancellation disposes the response, which aborts a body read that the
    /// stream itself would not cancel (as on .NET Framework), so a stalled body cannot outlive the deadline. That disposal,
    /// and the body stream's, are quiet: a response or stream that throws from Dispose neither throws into the code that
    /// cancels nor replaces a body that was read in full.
    /// </summary>
    internal static async Task<byte[]> ReadBodyAsync(HttpResponseMessage response, int limit, CancellationToken cancellationToken)
    {
        // .NET Framework leaves Content null when a handler builds a response without a body.
        if (response.Content is null)
        {
            return [];
        }

        using (cancellationToken.Register(static state => DisposeQuietly((HttpResponseMessage)state!), response))
        {
            return await ReadCappedAsync(response.Content, limit, cancellationToken).ConfigureAwait(false);
        }
    }

    /// <summary>Reads a response body, failing (rather than buffering without bound) once it exceeds <paramref name="limit"/>.</summary>
    internal static async Task<byte[]> ReadCappedAsync(HttpContent content, int limit, CancellationToken cancellationToken)
    {
        if (content.Headers.ContentLength is { } declared && declared > limit)
        {
            throw new InvalidDataException("The Logbird response is larger than expected.");
        }

#if NET8_0_OR_GREATER
        var stream = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
#else
        var stream = await content.ReadAsStreamAsync().ConfigureAwait(false);
#endif
        try
        {
            using var buffer = new MemoryStream();
            var chunk = new byte[16 * 1024];
            while (true)
            {
#if NET8_0_OR_GREATER
                var read = await stream.ReadAsync(chunk.AsMemory(), cancellationToken).ConfigureAwait(false);
#else
                var read = await stream.ReadAsync(chunk, 0, chunk.Length, cancellationToken).ConfigureAwait(false);
#endif
                if (read == 0)
                {
                    return buffer.ToArray();
                }

                if (buffer.Length + read > limit)
                {
                    throw new InvalidDataException("The Logbird response is larger than expected.");
                }

                buffer.Write(chunk, 0, read);
            }
        }
        finally
        {
            DisposeQuietly(stream);
        }
    }

    /// <summary>Disposes a response or stream of the transport's; a throwing Dispose never replaces the outcome.</summary>
    internal static void DisposeQuietly(IDisposable disposable)
    {
        try
        {
            disposable.Dispose();
        }
        catch
        {
            // Transport cleanup: whatever it throws is not the outcome, and its message is not reported.
        }
    }

    private HttpRequestMessage CreateRequest(byte[] body)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, _eventsUri)
        {
            Content = new ByteArrayContent(body),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Headers.Authorization = _authorization;
        request.Headers.TryAddWithoutValidation("X-Logbird-SDK", "dotnet/" + LogbirdClient.Version);
        request.Headers.TryAddWithoutValidation(RetryHeader, RetrySubset);
        request.Headers.UserAgent.Add(new ProductInfoHeaderValue("Logbird.NET", LogbirdClient.Version));
        return request;
    }

    private void Reject(State state, int[] attempt, JsonElement rejections)
    {
        // An empty list (every successful answer) reserves nothing: a released place still holds notifier capacity until
        // the drain reaches it, so successful batches would crowd real reports out behind a slow callback.
        if (rejections.ValueKind != JsonValueKind.Array || rejections.GetArrayLength() == 0)
        {
            return;
        }

        var codes = new List<string>();
        var post = _reserveReport();
        try
        {
            RejectEach(state, attempt, rejections, codes);
        }
        finally
        {
            // Whatever settled before a failure is still reported.
            post(codes.Count > 0 ? new LogbirdRejectedException(codes.Count, codes) : null);
        }
    }

    private void RejectEach(State state, int[] attempt, JsonElement rejections, List<string> codes)
    {
        foreach (var rejection in rejections.EnumerateArray())
        {
            if (rejection.ValueKind != JsonValueKind.Object
                || !rejection.TryGetProperty("index", out var indexElement)
                || !TryGetInteger(indexElement, out var wire)
                || !rejection.TryGetProperty("reason", out var reasonElement)
                || reasonElement.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            if (wire < 0 || wire >= attempt.Length)
            {
                continue;
            }

            // Read everything that can throw before settling, so a malformed reason never settles an unreported event.
            var reason = Text(reasonElement);
            var code = rejection.TryGetProperty("code", out var codeElement) && codeElement.ValueKind == JsonValueKind.String ? SafeCode(Text(codeElement)) : "other";
            var index = attempt[(int)wire];
            if (!state.TryReject(index, DropReason.Rejected, _drop(state.Batch[index], DropReason.Rejected, reason, code)))
            {
                continue;
            }

            codes.Add(code);
        }
    }

    /// <summary>
    /// Credits accepted ids to entries, one acknowledgement per entry. Entries already delivered earlier in this batch
    /// (for example by an identical earlier 503) consume their acknowledgement first, so a repeated response can never
    /// credit the same acknowledgement to a second entry with that id; entries the response marks unresolved are
    /// excluded from both passes.
    /// </summary>
    private static void Credit(State state, int[] attempt, Dictionary<string, int> acknowledgements, Func<int, bool> eligible)
    {
        for (var wire = 0; wire < attempt.Length; wire++)
        {
            var index = attempt[wire];
            var key = EventJson.JsTrim(state.Batch[index].Id);
            // An entry this response marks unresolved does not claim an acknowledgement, even if delivered earlier.
            if (eligible(wire) && state.WasDelivered(index) && acknowledgements.TryGetValue(key, out var times) && times > 0)
            {
                acknowledgements[key] = times - 1;
            }
        }

        for (var wire = 0; wire < attempt.Length; wire++)
        {
            var index = attempt[wire];
            var key = EventJson.JsTrim(state.Batch[index].Id);
            if (eligible(wire) && !state.IsSettled(index) && acknowledgements.TryGetValue(key, out var times) && times > 0)
            {
                acknowledgements[key] = times - 1;
                state.Deliver(index);
            }
        }
    }

    /// <summary>
    /// Reports the server's per-event warnings (for example an adjusted timestamp).
    /// Warnings for still-unresolved rows of a 503 are left for the attempt that settles them.
    /// </summary>
    private void Warn(State state, int[] attempt, JsonElement warnings, HashSet<long>? unresolved)
    {
        if (warnings.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (var warning in warnings.EnumerateArray())
        {
            if (warning.ValueKind != JsonValueKind.Object
                || !warning.TryGetProperty("index", out var indexElement)
                || !TryGetInteger(indexElement, out var wire)
                || wire < 0 || wire >= attempt.Length
                || unresolved?.Contains(wire) == true
                || !warning.TryGetProperty("reason", out var reasonElement)
                || reasonElement.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            _warn(state.Batch[attempt[(int)wire]], Text(reasonElement));
        }
    }

    /// <summary>Validates 503 details exactly like the TypeScript SDK; anything incomplete keeps the previous body.</summary>
    private static bool CompleteDetails(QueuedEvent[] batch, int[] attempt, JsonElement details, out Dictionary<string, int> acceptedIds, out HashSet<long> unresolved)
    {
        acceptedIds = new Dictionary<string, int>(StringComparer.Ordinal);
        unresolved = [];
        if (!details.TryGetProperty("ids", out var ids) || ids.ValueKind != JsonValueKind.Array
            || !details.TryGetProperty("accepted", out var accepted) || !TryGetNumber(accepted, out var acceptedCount)
            || !details.TryGetProperty("rejected", out var rejected) || rejected.ValueKind != JsonValueKind.Array
            || !details.TryGetProperty("indices", out var indices) || indices.ValueKind != JsonValueKind.Array
            || !details.TryGetProperty("eventIds", out var eventIds) || eventIds.ValueKind != JsonValueKind.Array
            || !details.TryGetProperty("warnings", out var warnings) || warnings.ValueKind != JsonValueKind.Array)
        {
            return false;
        }

        var idList = new List<string>();
        foreach (var id in ids.EnumerateArray())
        {
            if (id.ValueKind != JsonValueKind.String)
            {
                return false;
            }

            idList.Add(Text(id));
        }

        if (acceptedCount != idList.Count)
        {
            return false;
        }

        var rejectedIndices = new HashSet<long>();
        var rejectedCount = 0;
        foreach (var rejection in rejected.EnumerateArray())
        {
            if (rejection.ValueKind != JsonValueKind.Object
                || !rejection.TryGetProperty("index", out var indexElement)
                || !TryGetInteger(indexElement, out var index)
                || index < 0 || index >= attempt.Length
                || !rejection.TryGetProperty("reason", out var reason) || reason.ValueKind != JsonValueKind.String)
            {
                return false;
            }

            rejectedIndices.Add(index);
            rejectedCount++;
        }

        if (rejectedIndices.Count != rejectedCount)
        {
            return false;
        }

        var indexList = new List<long>();
        foreach (var element in indices.EnumerateArray())
        {
            if (!TryGetInteger(element, out var index) || index < 0 || index >= attempt.Length)
            {
                return false;
            }

            indexList.Add(index);
        }

        var eventIdList = new List<string>();
        foreach (var element in eventIds.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.String)
            {
                return false;
            }

            eventIdList.Add(Text(element));
        }

        if (indexList.Count != eventIdList.Count || new HashSet<long>(indexList).Count != indexList.Count)
        {
            return false;
        }

        for (var position = 0; position < indexList.Count; position++)
        {
            var index = indexList[position];
            if (eventIdList[position] != EventJson.JsTrim(batch[attempt[index]].Id) || rejectedIndices.Contains(index))
            {
                return false;
            }
        }

        foreach (var id in idList)
        {
            acceptedIds[id] = acceptedIds.TryGetValue(id, out var times) ? times + 1 : 1;
        }

        unresolved = [.. indexList];
        return true;
    }

    private static double? RetryAfter(HttpResponseMessage? response)
    {
        if (response is null)
        {
            return null;
        }

        if (response.Headers.RetryAfter is { } typed)
        {
            if (typed.Delta is { } delta)
            {
                return delta.TotalMilliseconds;
            }

            if (typed.Date is { } date)
            {
                return (date - DateTimeOffset.UtcNow).TotalMilliseconds;
            }
        }

        if (response.Headers.TryGetValues("Retry-After", out var values))
        {
            var raw = values.FirstOrDefault();
            if (raw is not null && double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds)
                && !double.IsNaN(seconds) && !double.IsInfinity(seconds))
            {
                return seconds * 1000;
            }
        }

        return null;
    }

    /// <summary>
    /// Decodes diagnostic text without letting its content change an outcome: a JSON string with an escaped lone
    /// surrogate (valid JSON, which JavaScript accepts) falls back to its raw JSON text.
    /// </summary>
    private static string Text(JsonElement element)
    {
        try
        {
            return element.GetString() ?? string.Empty;
        }
        catch (InvalidOperationException)
        {
            var raw = element.GetRawText();
            return raw.Length >= 2 ? raw.Substring(1, raw.Length - 2) : raw;
        }
    }

    private static readonly HashSet<string> KnownCodes = new(StringComparer.Ordinal)
    {
        "invalid_event",
        "invalid_event_id",
        "invalid_entity_id",
        "duplicate_id_conflict",
        "stored_event_unreadable",
        "unverified_after_parse_failure",
    };

    /// <summary>A rejection code from the response, kept only if it is a known protocol code (it reaches messages and logs).</summary>
    internal static string SafeCode(string code) => KnownCodes.Contains(code) ? code : "other";

    private static bool TryParse(byte[]? body, out JsonDocument document)
    {
        document = null!;
        if (body is null || body.Length == 0)
        {
            return false;
        }

        try
        {
            document = JsonDocument.Parse(body);
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool TryGetNumber(JsonElement element, out double value)
    {
        value = 0;
        return element.ValueKind == JsonValueKind.Number && element.TryGetDouble(out value);
    }

    private static bool TryGetInteger(JsonElement element, out long value)
    {
        value = 0;
        if (!TryGetNumber(element, out var number) || double.IsInfinity(number) || Math.Floor(number) != number
            || number < long.MinValue || number > long.MaxValue)
        {
            return false;
        }

        value = (long)number;
        return true;
    }

    /// <summary>Per-batch view over the events' own atomic states, so shutdown can take ownership of an event at any time.</summary>
    private sealed class State(QueuedEvent[] batch, Func<QueuedEvent, Action, bool> settle, Action? onDelivered, Action<DropReason>? countDrop)
    {
        private readonly bool[] _deliveredHere = new bool[batch.Length];

        private int _delivered;

        public QueuedEvent[] Batch { get; } = batch;

        public bool IsSettled(long index) => !Batch[index].IsPending;

        /// <summary>
        /// Settles an event as rejected or dropped, counting it and posting its prepared report in the same step, so no
        /// flush can see it settled before its report is posted. False when it was already settled or abandoned by shutdown.
        /// </summary>
        public bool TryReject(int index, DropReason reason, Action? report) => settle(Batch[index], () =>
        {
            countDrop?.Invoke(reason);
            report?.Invoke();
        });

        public void Deliver(int index)
        {
            if (settle(Batch[index], () => onDelivered?.Invoke()))
            {
                _delivered++;
                _deliveredHere[index] = true;
            }
        }

        /// <summary>Whether this batch's own responses delivered the entry (not rejected, not abandoned).</summary>
        public bool WasDelivered(int index) => _deliveredHere[index];

        public void DeliverRest(int[] attempt)
        {
            foreach (var index in attempt)
            {
                Deliver(index);
            }
        }

        public List<int> PendingIndices()
        {
            var pending = new List<int>();
            for (var i = 0; i < Batch.Length; i++)
            {
                if (Batch[i].IsPending)
                {
                    pending.Add(i);
                }
            }

            return pending;
        }

        public SendResult Complete() => new([], null, _delivered);

        public SendResult Fail(Exception failure) => new(PendingIndices().ConvertAll(i => Batch[i]), failure, _delivered);
    }
}
