using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Soak;

/// <summary>The faults the stand-in can inject, one chosen per ingest request by weight.</summary>
internal enum Fault
{
    /// <summary>202 (or the server's own answer) with no fault.</summary>
    Ok,

    /// <summary>A delay of up to two seconds, then the answer.</summary>
    Latency,

    /// <summary>503 ingest_pending whose details settle some events and list the rest as unresolved (indices/eventIds).</summary>
    PartialUnavailable,

    /// <summary>503 ingest_unavailable without details, without forwarding: the whole batch is retried.</summary>
    Unavailable,

    /// <summary>429 rate_limited with Retry-After, without forwarding.</summary>
    RateLimited,

    /// <summary>The connection is reset after the request headers, before the body is read, without forwarding.</summary>
    Reset,

    /// <summary>The events are stored (or forwarded and stored), then the connection is reset before the answer.</summary>
    ResetAfterStore,

    /// <summary>No answer until after the client's request timeout, then a reset, without forwarding.</summary>
    Hang,

    /// <summary>202 <c>{}</c> (a proxy answering for the server): nothing is acknowledged. Stored or forwarded first.</summary>
    EmptyAck,

    /// <summary>202 with some not-yet-stored events rejected per event (code invalid_event). Stand-in mode only.</summary>
    Reject,

    /// <summary>413 payload_too_large without forwarding: a permanent HTTP error for the batch.</summary>
    TooLarge,
}

/// <summary>
/// An in-process Logbird ingest stand-in on a real loopback socket. It answers <c>POST /v1/events</c> the way the server
/// does (apps/server ingest.ts, immutable-ingest.ts, rate-limit.ts; shapes from packages/contracts), records every event
/// it stores, every id it acknowledges to the client and each id's first-seen content, and injects faults. With an
/// upstream it forwards to a real Logbird instead of storing, with the same transport faults.
/// </summary>
internal sealed class StandIn : IDisposable
{
    private const int MaxEvents = 1000;
    private const int MaxBodyBytes = 5 * 1024 * 1024;
    private const int MaxEventBytes = 256 * 1024;
    private static readonly string Crlf = "" + (char)13 + (char)10;

    private readonly TcpListener _listener;
    private readonly (Fault Fault, int Weight)[] _weights;
    private readonly int _totalWeight;
    private readonly Random _random;
    private readonly object _randomGate = new();
    private readonly TimeSpan _hang;
    private readonly string _authorization;
    private readonly HttpClient? _upstream;
    private readonly Uri? _upstreamEvents;
    private readonly CancellationTokenSource _stop = new();
    private readonly LongMap _stored;
    private readonly LongMap _firstSeen;
    private readonly LongMap _acknowledged;
    private readonly ConcurrentDictionary<Fault, long> _faults = new();
    private readonly ConcurrentDictionary<Socket, byte> _sockets = new();
    private readonly Samples _samples;
    private Task? _accept;
    private long _conflicts;
    private long _requests;
    private long _resends;
    private long _connections;
    private int _inFlight;
    private int _cycled;

    public StandIn(IReadOnlyDictionary<Fault, int> weights, int seed, TimeSpan hang, string ingestKey, Samples samples, Uri? upstream, long expectedEvents)
    {
        _stored = new LongMap(expectedEvents);
        _firstSeen = new LongMap(expectedEvents);
        _acknowledged = new LongMap(expectedEvents);
        _weights = weights.Where(w => w.Value > 0).Select(w => (w.Key, w.Value)).ToArray();
        _totalWeight = _weights.Sum(w => w.Weight);
        _random = new Random(seed);
        _hang = hang;
        _authorization = "Bearer " + ingestKey;
        _samples = samples;
        if (upstream is not null)
        {
            // No redirects and no proxy: the forwarded requests carry the real ingest key and must stay on this machine.
            _upstream = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false }) { Timeout = TimeSpan.FromSeconds(60) };
            _upstreamEvents = new Uri(upstream, "v1/events");
        }

        _listener = new TcpListener(IPAddress.Loopback, 0);
    }

    /// <summary>The endpoint to give the client (http on loopback, which the SDK allows).</summary>
    public Uri Endpoint => new("http://127.0.0.1:" + ((IPEndPoint)_listener.LocalEndpoint).Port.ToString(CultureInfo.InvariantCulture));

    /// <summary>When set, every request is answered (or forwarded) with no fault: used to drain at the end.</summary>
    public bool Healthy { get; set; }

    /// <summary>Id hashes the stand-in stored (stand-in mode only).</summary>
    public LongMap Stored => _stored;

    /// <summary>Id hashes acknowledged to the client in an answer it received (accepted in a 202 or in 503 details).</summary>
    public LongMap Acknowledged => _acknowledged;

    /// <summary>First-seen fingerprints by id hash.</summary>
    public LongMap FirstSeen => _firstSeen;

    /// <summary>Times an id arrived with content different from its first arrival (the client changed a retried event).</summary>
    public long Conflicts => Interlocked.Read(ref _conflicts);

    /// <summary>Events received again after they were stored (retries after a lost answer), answered as accepted.</summary>
    public long Resends => Interlocked.Read(ref _resends);

    public long Requests => Interlocked.Read(ref _requests);

    public long Connections => Interlocked.Read(ref _connections);

    public IReadOnlyDictionary<Fault, long> Faults => _faults;

    public void Start()
    {
        _listener.Start();
        _accept = Task.Run(AcceptLoopAsync);
    }

    /// <summary>Waits until no request is being handled (forwards included), or the limit passes; false on timeout.</summary>
    public async Task<bool> QuiesceAsync(TimeSpan limit)
    {
        var deadline = DateTime.UtcNow + limit;
        while (Volatile.Read(ref _inFlight) > 0)
        {
            if (DateTime.UtcNow > deadline)
            {
                return false;
            }

            await Task.Delay(50).ConfigureAwait(false);
        }

        return true;
    }

    public void Dispose()
    {
        _stop.Cancel();
        _listener.Stop();
        try
        {
            _accept?.Wait(TimeSpan.FromSeconds(5));
        }
        catch (AggregateException)
        {
        }

        // Close every accepted connection, so no handler stays blocked waiting for a next request.
        foreach (var socket in _sockets.Keys)
        {
            try
            {
                socket.Close();
            }
            catch (ObjectDisposedException)
            {
            }
        }

        _upstream?.Dispose();
        _stop.Dispose();
    }

    private async Task AcceptLoopAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            Socket socket;
            try
            {
                socket = await _listener.AcceptSocketAsync().ConfigureAwait(false);
            }
            catch (Exception) when (_stop.IsCancellationRequested)
            {
                return;
            }
            catch (SocketException)
            {
                continue;
            }

            Interlocked.Increment(ref _connections);
            _sockets.TryAdd(socket, 0);
            _ = Task.Run(async () =>
            {
                try
                {
                    await ServeAsync(socket).ConfigureAwait(false);
                }
                finally
                {
                    _sockets.TryRemove(socket, out _);
                }
            });
        }
    }

    private Fault NextFault()
    {
        if (Healthy || _totalWeight == 0)
        {
            return Fault.Ok;
        }

        lock (_randomGate)
        {
            // The first requests go once through every configured fault, so even a short run exercises (and samples) each.
            if (_cycled < _weights.Length)
            {
                return _weights[_cycled++].Fault;
            }

            var roll = _random.Next(_totalWeight);
            foreach (var (fault, weight) in _weights)
            {
                if (roll < weight)
                {
                    return fault;
                }

                roll -= weight;
            }
        }

        return Fault.Ok;
    }

    private int NextInt(int max)
    {
        lock (_randomGate)
        {
            return _random.Next(max);
        }
    }

    private async Task ServeAsync(Socket socket)
    {
        using var stream = new NetworkStream(socket, ownsSocket: true);
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                var head = await ReadHeadAsync(stream).ConfigureAwait(false);
                if (head is null)
                {
                    return;
                }

                Interlocked.Increment(ref _requests);
                Interlocked.Increment(ref _inFlight);
                try
                {
                    var ingest = head.Path == "/v1/events" && head.Method == "POST";
                    var fault = ingest ? NextFault() : Fault.Ok;
                    if (ingest)
                    {
                        _faults.AddOrUpdate(fault, 1, (_, n) => n + 1);
                    }

                    if (!await HandleAsync(stream, socket, head, ingest, fault).ConfigureAwait(false))
                    {
                        return;
                    }
                }
                finally
                {
                    Interlocked.Decrement(ref _inFlight);
                }
            }
        }
        catch (Exception e) when (e is IOException or SocketException or ObjectDisposedException)
        {
            // The client closed or reset the connection; nothing to answer.
        }
    }

    /// <summary>Answers one request; false when the connection must not be reused (reset, hang, close).</summary>
    private async Task<bool> HandleAsync(NetworkStream stream, Socket socket, RequestHead head, bool ingest, Fault fault)
    {
        var exchange = new Exchange(fault);
        if (!ingest)
        {
            await DiscardBodyAsync(stream, head).ConfigureAwait(false);
            await WriteAsync(stream, exchange, 404, Error("not_found", "Not found."), null).ConfigureAwait(false);
            return true;
        }

        // Faults that answer before the body is read: the request never reaches storage.
        switch (fault)
        {
            case Fault.Reset:
                _samples.Add(exchange);
                Reset(socket);
                return false;
            case Fault.Hang:
                _samples.Add(exchange);
                await Task.Delay(_hang).ConfigureAwait(false);
                Reset(socket);
                return false;
        }

        if (head.ContentLength > MaxBodyBytes)
        {
            // The server's body limit answers without reading the body; the connection cannot be reused after that.
            await WriteAsync(stream, exchange, 413, Error("payload_too_large", "Request exceeds 5 MB."), null, close: true).ConfigureAwait(false);
            return false;
        }

        var body = await ReadBodyAsync(stream, head).ConfigureAwait(false);
        if (body is null)
        {
            return false;
        }

        exchange.Request = body;
        List<JsonNode?>? events;
        string[] raw;
        try
        {
            var root = JsonNode.Parse(body);
            events = root is JsonArray array ? [.. array]
                : root is JsonObject obj && obj.ContainsKey("events") ? obj["events"] is JsonArray list ? [.. list] : []
                : [root];
            raw = RawEvents(body);
        }
        catch (JsonException)
        {
            events = null;
            raw = [];
        }

        // Every arrival is fingerprinted as soon as its body is read, whatever the answer will be, so a retry with changed
        // content is caught in both modes, also after a 429, a 503 or a 413.
        for (var i = 0; i < (events?.Count ?? 0); i++)
        {
            if (Text(events![i] is JsonObject o ? o["id"] : null, out var id, out _) && JsTrim(id!).Length > 0)
            {
                var fingerprint = Fingerprint(events[i], i < raw.Length ? raw[i] : string.Empty);
                if (!_firstSeen.TryAdd(LongMap.Hash(JsTrim(id!)), fingerprint, out var first) && first != fingerprint)
                {
                    Interlocked.Increment(ref _conflicts);
                }
            }
        }

        switch (fault)
        {
            case Fault.RateLimited:
                await WriteAsync(stream, exchange, 429, Error("rate_limited", "Too many requests. Retry shortly."), "1").ConfigureAwait(false);
                return true;
            case Fault.Unavailable:
                await WriteAsync(stream, exchange, 503, Error("ingest_unavailable", "Event identity lookup is unavailable. Retry this batch."), "1").ConfigureAwait(false);
                return true;
            case Fault.TooLarge:
                await WriteAsync(stream, exchange, 413, Error("payload_too_large", "Request exceeds 5 MB."), null).ConfigureAwait(false);
                return true;
            case Fault.Latency:
                await Task.Delay(NextInt(2000)).ConfigureAwait(false);
                break;
        }

        if (_upstream is null && !string.Equals(head.Header("authorization"), _authorization, StringComparison.Ordinal))
        {
            await WriteAsync(stream, exchange, 401, Error("invalid_api_key", "A valid API key is required."), null).ConfigureAwait(false);
            return true;
        }

        if (events is null)
        {
            await WriteAsync(stream, exchange, 400, Error("invalid_json", "Invalid JSON or gzip body."), null).ConfigureAwait(false);
            return true;
        }

        if (events.Count == 0)
        {
            await WriteAsync(stream, exchange, 422, Error("validation_error", "events must be a nonempty array."), null).ConfigureAwait(false);
            return true;
        }

        if (events.Count > MaxEvents)
        {
            await WriteAsync(stream, exchange, 413, Error("payload_too_large", "Maximum 1000 events per request."), null).ConfigureAwait(false);
            return true;
        }

        return _upstream is null
            ? await StoreAsync(stream, socket, exchange, events, raw, fault).ConfigureAwait(false)
            : await ForwardAsync(stream, socket, exchange, head, body, events, fault).ConfigureAwait(false);
    }

    private async Task<bool> StoreAsync(NetworkStream stream, Socket socket, Exchange exchange, List<JsonNode?> events, string[] raw, Fault fault)
    {
        var accepted = new JsonArray();
        var rejected = new JsonArray();
        var unresolvedIndices = new JsonArray();
        var unresolvedIds = new JsonArray();
        for (var index = 0; index < events.Count; index++)
        {
            var e = events[index];
            var problem = Normalize(e, index < raw.Length ? raw[index] : string.Empty, out var id);
            if (problem is not null)
            {
                rejected.Add((JsonNode)Rejection(index, problem.Value.Code, problem.Value.Reason));
                exchange.Dispositions.Add("rejected");
                continue;
            }

            var fingerprint = Fingerprint(e, index < raw.Length ? raw[index] : string.Empty);
            var key = LongMap.Hash(id);
            var alreadyStored = _stored.TryGetValue(key, out var storedFingerprint);
            if (alreadyStored && storedFingerprint != fingerprint)
            {
                rejected.Add((JsonNode)Rejection(index, "duplicate_id_conflict", "duplicate_id_conflict: id conflicts with different content in this request or stored history. Send corrections with a new id and context.parentEventId."));
                exchange.Dispositions.Add("rejected");
                continue;
            }

            // Faults that settle only part of a batch never touch an event the stand-in already stored: the real server
            // acknowledges a stored id on every retry.
            if (!alreadyStored && fault == Fault.Reject && NextInt(4) == 0)
            {
                rejected.Add((JsonNode)Rejection(index, "invalid_event", "invalid_event: rejected by the soak stand-in (fault injection)"));
                exchange.Dispositions.Add("rejected");
                continue;
            }

            if (!alreadyStored && fault == Fault.PartialUnavailable && NextInt(2) == 0)
            {
                unresolvedIndices.Add((JsonNode)index);
                unresolvedIds.Add((JsonNode)id);
                exchange.Dispositions.Add("unresolved");
                continue;
            }

            if (alreadyStored)
            {
                Interlocked.Increment(ref _resends);
            }
            else if (!_stored.TryAdd(key, fingerprint, out var raced))
            {
                if (raced != fingerprint)
                {
                    // Another request stored this id meanwhile with different content.
                    rejected.Add((JsonNode)Rejection(index, "duplicate_id_conflict", "duplicate_id_conflict: id conflicts with different content in this request or stored history."));
                    exchange.Dispositions.Add("rejected");
                    continue;
                }

                // Another request stored the same content meanwhile: this arrival is a resend.
                Interlocked.Increment(ref _resends);
            }

            accepted.Add((JsonNode)id);
            exchange.Dispositions.Add("accepted");
        }

        if (fault == Fault.ResetAfterStore)
        {
            _samples.Add(exchange);
            Reset(socket);
            return false;
        }

        if (fault == Fault.EmptyAck)
        {
            await WriteAsync(stream, exchange, 202, new JsonObject(), null).ConfigureAwait(false);
            return true;
        }

        var result = new JsonObject
        {
            ["accepted"] = accepted.Count,
            ["ids"] = accepted,
            ["rejected"] = rejected,
            ["warnings"] = new JsonArray(),
        };
        if (unresolvedIndices.Count > 0)
        {
            result["indices"] = unresolvedIndices;
            result["eventIds"] = unresolvedIds;
            await WriteAsync(stream, exchange, 503, Error("ingest_pending", "Some events need a retry; listed indices are unresolved.", result), "1").ConfigureAwait(false);
            return true;
        }

        await WriteAsync(stream, exchange, 202, result, null).ConfigureAwait(false);
        return true;
    }

    /// <summary>Forwards a request to the real server, then applies the faults that need its answer.</summary>
    private async Task<bool> ForwardAsync(NetworkStream stream, Socket socket, Exchange exchange, RequestHead head, byte[] body, List<JsonNode?> events, Fault fault)
    {
        using var message = new HttpRequestMessage(HttpMethod.Post, _upstreamEvents) { Content = new ByteArrayContent(body) };
        message.Content.Headers.TryAddWithoutValidation("Content-Type", head.Header("content-type") ?? "application/json");
        foreach (var name in new[] { "authorization", "user-agent", "logbird-retry" })
        {
            if (head.Header(name) is { } value)
            {
                message.Headers.TryAddWithoutValidation(name, value);
            }
        }

        HttpResponseMessage response;
        try
        {
            response = await _upstream!.SendAsync(message).ConfigureAwait(false);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            _samples.Add(exchange);
            Reset(socket);
            return false;
        }

        using (response)
        {
            var bytes = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
            var status = (int)response.StatusCode;
            var answer = TryParse(bytes);
            if (fault == Fault.ResetAfterStore)
            {
                _samples.Add(exchange);
                Reset(socket);
                return false;
            }

            if (fault == Fault.EmptyAck && status == 202)
            {
                await WriteAsync(stream, exchange, 202, new JsonObject(), null).ConfigureAwait(false);
                return true;
            }

            if (fault == Fault.PartialUnavailable && status == 202 && answer is JsonObject stored && stored["ids"] is JsonArray storedIds)
            {
                // The server stored the batch; report some stored events as unresolved so the client resends them and the
                // server's own deduplication is exercised.
                var ids = storedIds.Select(n => n!.GetValue<string>()).ToList();
                var unresolved = new List<int>();
                for (var index = 0; index < events.Count; index++)
                {
                    var id = (events[index] as JsonObject)?["id"]?.GetValue<string>()?.Trim();
                    if (id is not null && ids.Contains(id) && NextInt(2) == 0)
                    {
                        unresolved.Add(index);
                        ids.Remove(id);
                    }
                }

                if (unresolved.Count > 0)
                {
                    var details = new JsonObject
                    {
                        ["accepted"] = ids.Count,
                        ["ids"] = new JsonArray(ids.Select(i => (JsonNode?)JsonValue.Create(i)).ToArray()),
                        ["rejected"] = stored["rejected"]?.DeepClone() ?? new JsonArray(),
                        ["warnings"] = new JsonArray(),
                        ["indices"] = new JsonArray(unresolved.Select(i => (JsonNode?)JsonValue.Create(i)).ToArray()),
                        ["eventIds"] = new JsonArray(unresolved.Select(i => (JsonNode?)JsonValue.Create(((JsonObject)events[i]!)["id"]!.GetValue<string>().Trim())).ToArray()),
                    };
                    await WriteAsync(stream, exchange, 503, Error("ingest_pending", "Some events need a retry; listed indices are unresolved.", details), "1").ConfigureAwait(false);
                    return true;
                }
            }

            var retryAfter = response.Headers.TryGetValues("Retry-After", out var values) ? values.FirstOrDefault() : null;
            exchange.Status = status;
            exchange.RetryAfter = retryAfter;
            exchange.Response = answer;
            _samples.Add(exchange);
            await WriteRawAsync(stream, status, bytes, retryAfter, close: false).ConfigureAwait(false);

            // Only an answer that reached the client acknowledges anything.
            Acknowledge(status, answer);
            return true;
        }
    }

    /// <summary>
    /// The server's per-event acceptance rules (packages/clickhouse/src/normalize.ts): the action must be a string; a
    /// string id must hold no NUL and no lone surrogate and be at most 256 UTF-16 code units once trimmed; the event's
    /// JSON must be at most 256 KB. A missing or blank id gets a generated one, as the server does. Null when accepted.
    /// </summary>
    private static (string Code, string Reason)? Normalize(JsonNode? e, string raw, out string id)
    {
        var o = e as JsonObject ?? [];
        id = string.Empty;

        // Any JSON string is an action, even one .NET cannot decode (a lone surrogate): JavaScript strings allow it.
        if (!Text(o["action"], out _, out var actionIsString) && !actionIsString)
        {
            return ("invalid_event", "invalid_event: action must be a string");
        }

        const string BadId = "invalid_event_id: id must be valid Unicode, at most 256 UTF-16 code units, and contain no NUL";
        var decoded = Text(o["id"], out var given, out var idIsString);
        if (idIsString && !decoded)
        {
            // An escaped lone surrogate: .NET refuses to decode it, the server refuses the id.
            return ("invalid_event_id", BadId);
        }

        if (decoded)
        {
            if (given!.IndexOf((char)0) >= 0 || HasLoneSurrogate(given) || JsTrim(given).Length > 256)
            {
                return ("invalid_event_id", BadId);
            }

            id = JsTrim(given);
        }

        if (id.Length == 0)
        {
            id = Guid.NewGuid().ToString();
        }

        // The server measures the event re-serialized compactly (JSON.stringify of the parsed event), not the wire bytes.
        if (Encoding.UTF8.GetByteCount(Compact(raw.Length > 0 ? raw : e!.ToJsonString())) > MaxEventBytes)
        {
            return ("invalid_event", "invalid_event: event exceeds 256 KB");
        }

        return null;
    }

    /// <summary>
    /// Reads a JSON string value. True with the text when it decodes; false when the node is not a string, or is a string
    /// .NET cannot decode (an escaped lone surrogate), which <paramref name="isString"/> tells apart.
    /// </summary>
    private static bool Text(JsonNode? node, out string? text, out bool isString)
    {
        text = null;
        isString = node is JsonValue value && value.GetValueKind() == JsonValueKind.String;
        if (!isString)
        {
            return false;
        }

        try
        {
            text = node!.GetValue<string>();
            return true;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    /// <summary>String.prototype.trim: JavaScript's whitespace set, which includes U+FEFF (unlike .NET's Trim).</summary>
    private static string JsTrim(string value)
    {
        var start = 0;
        var end = value.Length;
        while (start < end && IsJsWhiteSpace(value[start]))
        {
            start++;
        }

        while (end > start && IsJsWhiteSpace(value[end - 1]))
        {
            end--;
        }

        return start == 0 && end == value.Length ? value : value.Substring(start, end - start);
    }

    private static bool IsJsWhiteSpace(char c)
        => c is (char)9 or (char)10 or (char)11 or (char)12 or (char)13 or (char)32 or (char)0xA0 or (char)0x1680
            or (char)0x2028 or (char)0x2029 or (char)0x202F or (char)0x205F or (char)0x3000 or (char)0xFEFF
            || (c >= (char)0x2000 && c <= (char)0x200A);

    /// <summary>JSON text without the whitespace outside strings: the compact form JSON.stringify gives the parsed event.</summary>
    private static string Compact(string json)
    {
        var builder = new StringBuilder(json.Length);
        var inString = false;
        for (var i = 0; i < json.Length; i++)
        {
            var c = json[i];
            if (inString)
            {
                builder.Append(c);
                if (c == (char)92 && i + 1 < json.Length)
                {
                    builder.Append(json[++i]);
                }
                else if (c == (char)34)
                {
                    inString = false;
                }
            }
            else if (c == (char)34)
            {
                inString = true;
                builder.Append(c);
            }
            else if (c is not ((char)32 or (char)9 or (char)10 or (char)13))
            {
                builder.Append(c);
            }
        }

        return builder.ToString();
    }

    /// <summary>Each event's raw JSON text, in the order the server reads the body (never decoded, so always available).</summary>
    private static string[] RawEvents(byte[] body)
    {
        using var document = JsonDocument.Parse(body);
        var root = document.RootElement;
        if (root.ValueKind == JsonValueKind.Array)
        {
            return root.EnumerateArray().Select(e => e.GetRawText()).ToArray();
        }

        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("events", out var list))
        {
            return list.ValueKind == JsonValueKind.Array ? list.EnumerateArray().Select(e => e.GetRawText()).ToArray() : [];
        }

        return [root.GetRawText()];
    }

    private static bool HasLoneSurrogate(string value)
    {
        for (var i = 0; i < value.Length; i++)
        {
            if (char.IsHighSurrogate(value[i]) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
            {
                i++;
            }
            else if (char.IsSurrogate(value[i]))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// A fingerprint of an event's parsed content, independent of key order and whitespace (like the server's identity).
    /// Content .NET cannot decode (a lone surrogate) falls back to the event's raw JSON text.
    /// </summary>
    private static long Fingerprint(JsonNode? node, string raw)
    {
        var builder = new StringBuilder();
        try
        {
            Canonical(node, builder);
        }
        catch (InvalidOperationException)
        {
            builder.Clear().Append("raw:").Append(raw);
        }

        unchecked
        {
            var hash = (long)14695981039346656037UL;
            foreach (var c in builder.ToString())
            {
                hash = (hash ^ c) * 1099511628211L;
            }

            return hash;
        }
    }

    private static void Canonical(JsonNode? node, StringBuilder builder)
    {
        switch (node)
        {
            case JsonObject o:
                builder.Append('{');
                foreach (var pair in o.OrderBy(p => p.Key, StringComparer.Ordinal))
                {
                    builder.Append(JsonValue.Create(pair.Key)!.ToJsonString()).Append(':');
                    Canonical(pair.Value, builder);
                    builder.Append(',');
                }

                builder.Append('}');
                break;
            case JsonArray a:
                builder.Append('[');
                foreach (var item in a)
                {
                    Canonical(item, builder);
                    builder.Append(',');
                }

                builder.Append(']');
                break;
            case null:
                builder.Append("null");
                break;
            default:
                builder.Append(node.ToJsonString());
                break;
        }
    }

    private void Acknowledge(int status, JsonNode? answer)
    {
        // Any JSON may come back from a local gateway; only the server's object shapes acknowledge anything.
        var ids = answer is not JsonObject root ? null
            : status == 202 ? root["ids"] as JsonArray
            : status == 503 && root["error"] is JsonObject error && error["details"] is JsonObject details ? details["ids"] as JsonArray
            : null;
        foreach (var id in ids ?? [])
        {
            if (id is JsonValue v && v.TryGetValue<string>(out var text))
            {
                _acknowledged.TryAdd(LongMap.Hash(text), 0);
            }
        }
    }

    private static JsonNode? TryParse(byte[] bytes)
    {
        try
        {
            return bytes.Length == 0 ? null : JsonNode.Parse(bytes);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static JsonObject Rejection(int index, string code, string reason) => new() { ["index"] = index, ["reason"] = reason, ["code"] = code };

    private static JsonObject Error(string code, string message, JsonNode? details = null)
    {
        var error = new JsonObject { ["code"] = code, ["message"] = message };
        if (details is not null)
        {
            error["details"] = details;
        }

        return new JsonObject { ["error"] = error };
    }

    private static void Reset(Socket socket)
    {
        try
        {
            socket.LingerState = new LingerOption(true, 0);
            socket.Close();
        }
        catch (Exception e) when (e is SocketException or ObjectDisposedException)
        {
        }
    }

    private async Task WriteAsync(NetworkStream stream, Exchange exchange, int status, JsonNode body, string? retryAfter, bool close = false)
    {
        exchange.Status = status;
        exchange.RetryAfter = retryAfter;
        exchange.Response = body;
        await WriteRawAsync(stream, status, Encoding.UTF8.GetBytes(body.ToJsonString()), retryAfter, close).ConfigureAwait(false);
        _samples.Add(exchange);

        // Only an answer that reached the client acknowledges anything.
        Acknowledge(status, body);
    }

    private static async Task WriteRawAsync(NetworkStream stream, int status, byte[] body, string? retryAfter, bool close)
    {
        var head = new StringBuilder();
        head.Append("HTTP/1.1 ").Append(status).Append(' ').Append(Reason(status)).Append(Crlf);
        head.Append("Content-Type: application/json").Append(Crlf);
        head.Append("Content-Length: ").Append(body.Length).Append(Crlf);
        if (retryAfter is not null)
        {
            head.Append("Retry-After: ").Append(retryAfter).Append(Crlf);
        }

        if (close)
        {
            head.Append("Connection: close").Append(Crlf);
        }

        head.Append(Crlf);
        var headBytes = Encoding.ASCII.GetBytes(head.ToString());
        await stream.WriteAsync(headBytes, 0, headBytes.Length).ConfigureAwait(false);
        await stream.WriteAsync(body, 0, body.Length).ConfigureAwait(false);
        await stream.FlushAsync().ConfigureAwait(false);
    }

    private static string Reason(int status) => status switch
    {
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Status",
    };

    /// <summary>Reads one HTTP/1.1 request line and headers; null when the client closed the connection.</summary>
    private static async Task<RequestHead?> ReadHeadAsync(NetworkStream stream)
    {
        var buffer = new List<byte>(1024);
        var one = new byte[1];
        while (true)
        {
            var read = await stream.ReadAsync(one, 0, 1).ConfigureAwait(false);
            if (read == 0)
            {
                return null;
            }

            buffer.Add(one[0]);
            var n = buffer.Count;
            if (n >= 4 && buffer[n - 4] == 13 && buffer[n - 3] == 10 && buffer[n - 2] == 13 && buffer[n - 1] == 10)
            {
                break;
            }

            if (n > 64 * 1024)
            {
                return null;
            }
        }

        var lines = Encoding.ASCII.GetString(buffer.ToArray()).Split([Crlf], StringSplitOptions.RemoveEmptyEntries);
        var first = lines[0].Split(' ');
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1))
        {
            var colon = line.IndexOf(':');
            if (colon > 0)
            {
                headers[line.Substring(0, colon).Trim()] = line.Substring(colon + 1).Trim();
            }
        }

        var length = headers.TryGetValue("content-length", out var text) && long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
        var path = first.Length > 1 ? first[1] : "/";
        var query = path.IndexOf('?');
        return new RequestHead(first[0], query >= 0 ? path.Substring(0, query) : path, headers, length);
    }

    private static async Task<byte[]?> ReadBodyAsync(NetworkStream stream, RequestHead head)
    {
        var body = new byte[head.ContentLength];
        var offset = 0;
        while (offset < body.Length)
        {
            var read = await stream.ReadAsync(body, offset, body.Length - offset).ConfigureAwait(false);
            if (read == 0)
            {
                return null;
            }

            offset += read;
        }

        return body;
    }

    private static async Task DiscardBodyAsync(NetworkStream stream, RequestHead head)
    {
        if (head.ContentLength is > 0 and <= MaxBodyBytes)
        {
            await ReadBodyAsync(stream, head).ConfigureAwait(false);
        }
    }

    private sealed class RequestHead(string method, string path, Dictionary<string, string> headers, long contentLength)
    {
        public string Method { get; } = method;

        public string Path { get; } = path;

        public long ContentLength { get; } = contentLength;

        public string? Header(string name) => headers.TryGetValue(name, out var value) ? value : null;
    }
}

/// <summary>One request and what the stand-in did with it, for the contract check.</summary>
internal sealed class Exchange(Fault fault)
{
    public Fault Fault { get; } = fault;

    public byte[]? Request { get; set; }

    public int? Status { get; set; }

    public string? RetryAfter { get; set; }

    public JsonNode? Response { get; set; }

    /// <summary>Per event, in order: accepted, rejected or unresolved (stand-in mode).</summary>
    public List<string> Dispositions { get; } = [];
}

/// <summary>
/// A bounded sample of exchanges (request, fault, status, Retry-After, answer, per-event dispositions), written as JSON
/// Lines for tests/cross-sdk/validate-stand-in.ts, which checks each against packages/contracts and the server's rules.
/// The first line lists the fault weights, so the check can require every configured fault to appear.
/// </summary>
internal sealed class Samples : IDisposable
{
    private const int PerKind = 25;
    private readonly ConcurrentDictionary<string, int> _counts = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private readonly StreamWriter _writer;

    /// <summary>Opens the file and writes the config line; exchanges are written as they arrive, never kept in memory.</summary>
    public Samples(IReadOnlyDictionary<Fault, int> weights, string mode, string path)
    {
        _writer = new StreamWriter(path);
        var config = new JsonObject { ["kind"] = "config", ["mode"] = mode, ["faults"] = new JsonObject() };
        foreach (var w in weights)
        {
            config["faults"]![w.Key.ToString()] = w.Value;
        }

        _writer.WriteLine(config.ToJsonString());
        _writer.Flush();
    }

    public void Add(Exchange exchange)
    {
        var kind = exchange.Fault + ":" + (exchange.Status?.ToString(CultureInfo.InvariantCulture) ?? "none");
        if (_counts.AddOrUpdate(kind, 1, (_, n) => n + 1) > PerKind)
        {
            return;
        }

        string text;
        try
        {
            text = new JsonObject
            {
                ["kind"] = "exchange",
                ["fault"] = exchange.Fault.ToString(),
                ["status"] = exchange.Status,
                ["retryAfter"] = exchange.RetryAfter,
                ["request"] = exchange.Request is null ? null : TryParse(exchange.Request),
                ["response"] = exchange.Response?.DeepClone(),
                ["dispositions"] = new JsonArray(exchange.Dispositions.Select(d => (JsonNode?)JsonValue.Create(d)).ToArray()),
            }.ToJsonString();
        }
        catch (InvalidOperationException)
        {
            // The request holds text .NET cannot re-encode (a lone surrogate). Sampling never stops an answer: record the
            // exchange without its request, flagged, so the check verifies only its status and code.
            text = new JsonObject
            {
                ["kind"] = "exchange",
                ["fault"] = exchange.Fault.ToString(),
                ["status"] = exchange.Status,
                ["retryAfter"] = exchange.RetryAfter,
                ["request"] = null,
                ["response"] = null,
                ["dispositions"] = new JsonArray(),
                ["undecodable"] = true,
            }.ToJsonString();
        }

        lock (_gate)
        {
            _writer.WriteLine(text);
            _writer.Flush();
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _writer.Dispose();
        }
    }

    private static JsonNode? TryParse(byte[] bytes)
    {
        try
        {
            return JsonNode.Parse(bytes);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
