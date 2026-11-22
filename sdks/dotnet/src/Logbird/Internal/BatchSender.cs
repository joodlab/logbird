using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
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
    private static readonly TimeSpan MaxAttemptTime = TimeSpan.FromSeconds(30);

    private readonly HttpClient _http;
    private readonly Uri _eventsUri;
    private readonly AuthenticationHeaderValue _authorization;
    private readonly int _maxRetries;
    private readonly Action<QueuedEvent, DropReason, string?> _drop;
    private readonly Action<Exception> _report;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private readonly Func<double> _random;
    private readonly Func<TimeSpan> _elapsed;

    public BatchSender(
        HttpClient http,
        Uri endpoint,
        string ingestKey,
        int maxRetries,
        Action<QueuedEvent, DropReason, string?> drop,
        Action<Exception> report,
        Func<TimeSpan, CancellationToken, Task>? delay = null,
        Func<double>? random = null,
        Func<TimeSpan>? clock = null)
    {
        _http = http;
        _eventsUri = EventsUri(endpoint);
        _authorization = new AuthenticationHeaderValue("Bearer", ingestKey);
        _maxRetries = maxRetries;
        _drop = drop;
        _report = report;
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

    internal static Uri EventsUri(Uri endpoint) => new(endpoint.AbsoluteUri.TrimEnd('/') + "/v1/events");

    public async Task<SendResult> SendAsync(QueuedEvent[] batch, CancellationToken stop)
    {
        var state = new State(batch);
        try
        {
            return await SendCoreAsync(state, stop).ConfigureAwait(false);
        }
        catch (Exception e)
        {
            // Never lose settlement already recorded: only still-pending events go back to the queue.
            return state.Fail(new LogbirdDeliveryException("Logbird delivery failed unexpectedly: " + e.GetType().Name, e));
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
        for (var attemptNumber = 0; ; attemptNumber++)
        {
            var remaining = deadline - _elapsed();
            if (remaining <= TimeSpan.Zero)
            {
                return state.Fail(new LogbirdDeliveryException("Logbird send exceeded its five-minute time limit."));
            }

            var progressed = false;
            HttpResponseMessage? response = null;
            byte[]? responseBody = null;
            Exception? error = null;
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stop);
                timeout.CancelAfter(remaining < MaxAttemptTime ? remaining : MaxAttemptTime);
                using var request = CreateRequest(body);
                response = await _http.SendAsync(request, timeout.Token).ConfigureAwait(false);
#if NET8_0_OR_GREATER
                responseBody = await response.Content.ReadAsByteArrayAsync(timeout.Token).ConfigureAwait(false);
#else
                // SendAsync already buffered the body (ResponseContentRead), so no token is needed here.
                responseBody = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
#endif
            }
            catch (Exception e)
            {
                // Any transport failure, including one thrown by a custom handler in the pipeline, is retryable.
                response?.Dispose();
                response = null;
                error = e;
            }

            using (response)
            {
                if (stop.IsCancellationRequested)
                {
                    return state.Fail(new LogbirdDeliveryException("Logbird delivery was stopped by shutdown."));
                }

                var status = response is null ? 0 : (int)response.StatusCode;
                if (status is >= 200 and < 300)
                {
                    JsonDocument document;
                    try
                    {
                        document = JsonDocument.Parse(responseBody);
                    }
                    catch (JsonException)
                    {
                        return state.Fail(new LogbirdDeliveryException($"Logbird HTTP {status} returned a response that is not JSON."));
                    }

                    using (document)
                    {
                        if (document.RootElement.ValueKind == JsonValueKind.Null)
                        {
                            return state.Fail(new LogbirdDeliveryException($"Logbird HTTP {status} returned an empty result."));
                        }

                        if (document.RootElement.ValueKind == JsonValueKind.Object
                            && document.RootElement.TryGetProperty("rejected", out var rejected))
                        {
                            Reject(state, attempt, rejected);
                        }
                    }

                    state.DeliverRest(attempt);
                    return state.Complete();
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
                            && code.GetString() is "ingest_pending" or "ingest_unavailable")
                        {
                            var hasDetails = errorElement.TryGetProperty("details", out var details) && details.ValueKind == JsonValueKind.Object;
                            if (hasDetails && details.TryGetProperty("rejected", out var detailRejected))
                            {
                                Reject(state, attempt, detailRejected);
                            }

                            if (hasDetails && CompleteDetails(batch, attempt, details, out var acceptedIds, out var unresolved))
                            {
                                for (var wire = 0; wire < attempt.Length; wire++)
                                {
                                    var index = attempt[wire];
                                    if (!unresolved.Contains(wire) && acceptedIds.Contains(EventJson.JsTrim(batch[index].Id)))
                                    {
                                        state.Deliver(index);
                                    }
                                }

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

                var retryable = response is null || status == 429 || status >= 500;
                if (!retryable)
                {
                    foreach (var index in state.PendingIndices())
                    {
                        if (!state.TryReject(index))
                        {
                            continue;
                        }

                        _drop(batch[index], DropReason.HttpError, "HTTP " + status.ToString(CultureInfo.InvariantCulture));
                    }

                    _report(new LogbirdDeliveryException($"Logbird HTTP {status}; batch dropped.", (HttpStatusCode)status));
                    return state.Complete();
                }

                // Progress attempts strictly shrink the body, so there can be at most batch.Length of them. Only
                // non-progress failures consume MaxRetries; a hard total-attempt bound is kept as well.
                if ((!progressed && retries >= _maxRetries) || attemptNumber >= batch.Length + _maxRetries - 1)
                {
                    return state.Fail(error is null
                        ? new LogbirdDeliveryException($"Logbird HTTP {status}", (HttpStatusCode)status)
                        : new LogbirdDeliveryException("Logbird could not be reached.", error));
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
        if (rejections.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        var codes = new List<string>();
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
            var reason = reasonElement.GetString();
            var code = rejection.TryGetProperty("code", out var codeElement) && codeElement.ValueKind == JsonValueKind.String ? codeElement.GetString()! : "rejected";
            var index = attempt[(int)wire];
            if (!state.TryReject(index))
            {
                continue;
            }

            codes.Add(code);
            _drop(state.Batch[index], DropReason.Rejected, reason);
        }

        if (codes.Count > 0)
        {
            _report(new LogbirdRejectedException(codes.Count, codes));
        }
    }

    /// <summary>Validates 503 details exactly like the TypeScript SDK; anything incomplete keeps the previous body.</summary>
    private static bool CompleteDetails(QueuedEvent[] batch, int[] attempt, JsonElement details, out HashSet<string> acceptedIds, out HashSet<long> unresolved)
    {
        acceptedIds = [];
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

            idList.Add(id.GetString()!);
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

            eventIdList.Add(element.GetString()!);
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

        acceptedIds = [.. idList];
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
    private sealed class State(QueuedEvent[] batch)
    {
        private int _delivered;

        public QueuedEvent[] Batch { get; } = batch;

        public bool IsSettled(long index) => !Batch[index].IsPending;

        /// <summary>Settles an event as rejected or dropped. False when it was already settled or abandoned by shutdown.</summary>
        public bool TryReject(int index) => Batch[index].TrySettle();

        public void Deliver(int index)
        {
            if (Batch[index].TrySettle())
            {
                _delivered++;
            }
        }

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
