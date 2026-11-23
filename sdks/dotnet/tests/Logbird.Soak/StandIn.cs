using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
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
    /// <summary>202 with every event acknowledged.</summary>
    Ok,

    /// <summary>A delay of up to two seconds, then 202.</summary>
    Latency,

    /// <summary>503 ingest_pending whose details settle some events and list the rest as unresolved (indices/eventIds).</summary>
    PartialUnavailable,

    /// <summary>503 ingest_unavailable without details: the whole batch is retried.</summary>
    Unavailable,

    /// <summary>429 rate_limited with Retry-After.</summary>
    RateLimited,

    /// <summary>The connection is reset before the request is read.</summary>
    Reset,

    /// <summary>The events are stored, then the connection is reset before the answer: the client must retry without duplicating.</summary>
    ResetAfterStore,

    /// <summary>No answer until after the client's request timeout, then a reset.</summary>
    Hang,

    /// <summary>202 that acknowledges nothing (a proxy answering for the server): the events must not count as delivered.</summary>
    EmptyAck,

    /// <summary>202 with some not-yet-stored events rejected per event (code invalid_event).</summary>
    Reject,

    /// <summary>413 payload_too_large: a permanent HTTP error for the batch.</summary>
    TooLarge,
}

/// <summary>
/// An in-process Logbird ingest stand-in on a real loopback socket. It answers <c>POST /v1/events</c> like the server
/// (shapes from packages/contracts: ingestResponseSchema, ingestPendingDetailsSchema, apiErrorSchema; codes from
/// ingestRejectionCodeSchema and the server's 413/429 answers), records every event it stores by id, and injects faults.
/// With an upstream it forwards to a real Logbird instead of storing, injecting the same transport faults.
/// </summary>
internal sealed class StandIn : IDisposable
{
    private const int MaxEvents = 1000;
    private const int MaxBodyBytes = 5 * 1024 * 1024;
    private const int MaxEventBytes = 256 * 1024;
    private static readonly string Crlf = "" + (char)13 + (char)10;
    private static readonly byte[] HeaderEnd = [13, 10, 13, 10];

    private readonly TcpListener _listener;
    private readonly (Fault Fault, int Weight)[] _weights;
    private readonly int _totalWeight;
    private readonly Random _random;
    private readonly object _randomGate = new();
    private readonly TimeSpan _hang;
    private readonly HttpClient? _upstream;
    private readonly Uri? _upstreamEvents;
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentDictionary<Guid, long> _stored = new();
    private readonly ConcurrentDictionary<Fault, long> _faults = new();
    private readonly Samples _samples;
    private Task? _accept;
    private long _conflicts;
    private long _requests;
    private long _resends;
    private long _connections;

    public StandIn(IReadOnlyDictionary<Fault, int> weights, int seed, TimeSpan hang, Samples samples, Uri? upstream)
    {
        _weights = weights.Where(w => w.Value > 0).Select(w => (w.Key, w.Value)).ToArray();
        _totalWeight = _weights.Sum(w => w.Weight);
        _random = new Random(seed);
        _hang = hang;
        _samples = samples;
        if (upstream is not null)
        {
            _upstream = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(60) };
            _upstreamEvents = new Uri(upstream, "v1/events");
        }

        _listener = new TcpListener(IPAddress.Loopback, 0);
    }

    /// <summary>The endpoint to give the client (http on loopback, which the SDK allows).</summary>
    public Uri Endpoint => new("http://127.0.0.1:" + ((IPEndPoint)_listener.LocalEndpoint).Port.ToString(System.Globalization.CultureInfo.InvariantCulture));

    /// <summary>When set, every request is answered 202 (or forwarded) with no fault: used to drain at the end.</summary>
    public bool Healthy { get; set; }

    /// <summary>Ids stored, with a hash of each event's exact JSON (stand-in mode only).</summary>
    public IReadOnlyDictionary<Guid, long> Stored => _stored;

    /// <summary>Requests that sent an id already stored with different content (the client changed a retried event).</summary>
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
            _ = Task.Run(() => ServeAsync(socket));
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
                var request = await ReadRequestAsync(stream).ConfigureAwait(false);
                if (request is null)
                {
                    return;
                }

                Interlocked.Increment(ref _requests);
                var fault = request.Path == "/v1/events" && request.Method == "POST" ? NextFault() : Fault.Ok;
                _faults.AddOrUpdate(fault, 1, (_, n) => n + 1);
                var keepOpen = await HandleAsync(stream, socket, request, fault).ConfigureAwait(false);
                if (!keepOpen)
                {
                    return;
                }
            }
        }
        catch (Exception e) when (e is IOException or SocketException or ObjectDisposedException)
        {
            // The client closed or reset the connection; nothing to answer.
        }
    }

    /// <summary>Answers one request; false when the connection must not be reused (reset, hang, close).</summary>
    private async Task<bool> HandleAsync(NetworkStream stream, Socket socket, HttpRequest request, Fault fault)
    {
        if (request.Path != "/v1/events" || request.Method != "POST")
        {
            await WriteJsonAsync(stream, 404, Error("not_found", "Not found."), null).ConfigureAwait(false);
            return true;
        }

        switch (fault)
        {
            case Fault.Reset:
                Reset(socket);
                return false;
            case Fault.Hang:
                await Task.Delay(_hang).ConfigureAwait(false);
                Reset(socket);
                return false;
            case Fault.RateLimited:
                await WriteJsonAsync(stream, 429, Error("rate_limited", "Too many requests. Retry shortly."), "1").ConfigureAwait(false);
                return true;
            case Fault.Unavailable:
                await WriteJsonAsync(stream, 503, Error("ingest_unavailable", "Event identity lookup is unavailable. Retry this batch."), "1").ConfigureAwait(false);
                return true;
            case Fault.TooLarge:
                await WriteJsonAsync(stream, 413, Error("payload_too_large", "Request exceeds 5 MB."), null).ConfigureAwait(false);
                return true;
            case Fault.Latency:
                await Task.Delay(NextInt(2000)).ConfigureAwait(false);
                break;
        }

        if (request.Body.Length > MaxBodyBytes)
        {
            await WriteJsonAsync(stream, 413, Error("payload_too_large", "Request exceeds 5 MB."), null).ConfigureAwait(false);
            return true;
        }

        if (_upstream is not null)
        {
            return await ForwardAsync(stream, socket, request, fault).ConfigureAwait(false);
        }

        JsonElement[] events;
        try
        {
            using var document = JsonDocument.Parse(request.Body);
            events = document.RootElement.ValueKind == JsonValueKind.Object && document.RootElement.TryGetProperty("events", out var list) && list.ValueKind == JsonValueKind.Array
                ? list.EnumerateArray().Select(e => e.Clone()).ToArray()
                : [];
        }
        catch (JsonException)
        {
            await WriteJsonAsync(stream, 400, Error("invalid_body", "Body must be JSON."), null).ConfigureAwait(false);
            return true;
        }

        if (events.Length is 0 or > MaxEvents)
        {
            await WriteJsonAsync(stream, 400, Error("validation_error", "A batch holds 1 to 1000 events."), null).ConfigureAwait(false);
            return true;
        }

        _samples.Request(request.Body);
        var accepted = new JsonArray();
        var rejected = new JsonArray();
        var unresolvedIndices = new JsonArray();
        var unresolvedIds = new JsonArray();
        for (var index = 0; index < events.Length; index++)
        {
            var e = events[index];
            var check = Validate(e);
            if (check is not null)
            {
                rejected.Add((JsonNode)Rejection(index, check.Value.Code, check.Value.Reason));
                continue;
            }

            var id = e.GetProperty("id").GetString()!;
            var key = Guid.Parse(id);
            var hash = Fnv(e.GetRawText());
            var alreadyStored = _stored.TryGetValue(key, out var storedHash);
            if (alreadyStored && storedHash != hash)
            {
                Interlocked.Increment(ref _conflicts);
                rejected.Add((JsonNode)Rejection(index, "duplicate_id_conflict", "duplicate_id_conflict: id conflicts with different content in this request or stored history."));
                continue;
            }

            // Faults that settle only part of the batch never touch an event the stand-in already stored: the real
            // server acknowledges a stored id on every retry.
            if (!alreadyStored && fault == Fault.Reject && NextInt(4) == 0)
            {
                rejected.Add((JsonNode)Rejection(index, "invalid_event", "invalid_event: rejected by the soak stand-in (fault injection)"));
                continue;
            }

            if (!alreadyStored && fault == Fault.PartialUnavailable && NextInt(2) == 0)
            {
                unresolvedIndices.Add((JsonNode)index);
                unresolvedIds.Add((JsonNode)id);
                continue;
            }

            if (fault == Fault.EmptyAck)
            {
                continue;
            }

            if (alreadyStored)
            {
                Interlocked.Increment(ref _resends);
            }
            else
            {
                _stored.TryAdd(key, hash);
            }

            accepted.Add((JsonNode)id);
        }

        if (fault == Fault.ResetAfterStore)
        {
            Reset(socket);
            return false;
        }

        if (fault == Fault.EmptyAck)
        {
            await WriteJsonAsync(stream, 202, new JsonObject(), null).ConfigureAwait(false);
            return true;
        }

        var body = new JsonObject
        {
            ["accepted"] = accepted.Count,
            ["ids"] = accepted,
            ["rejected"] = rejected,
            ["warnings"] = new JsonArray(),
        };
        if (unresolvedIndices.Count > 0)
        {
            body["indices"] = unresolvedIndices;
            body["eventIds"] = unresolvedIds;
            await WriteJsonAsync(stream, 503, Error("ingest_pending", "Some events need a retry; listed indices are unresolved.", body), "1").ConfigureAwait(false);
            return true;
        }

        await WriteJsonAsync(stream, 202, body, null).ConfigureAwait(false);
        return true;
    }

    /// <summary>Forwards a request to the real server, then applies the faults that need its answer.</summary>
    private async Task<bool> ForwardAsync(NetworkStream stream, Socket socket, HttpRequest request, Fault fault)
    {
        using var message = new HttpRequestMessage(HttpMethod.Post, _upstreamEvents) { Content = new ByteArrayContent(request.Body) };
        message.Content.Headers.TryAddWithoutValidation("Content-Type", request.Header("content-type") ?? "application/json");
        foreach (var name in new[] { "authorization", "user-agent", "logbird-retry" })
        {
            if (request.Header(name) is { } value)
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
            Reset(socket);
            return false;
        }

        using (response)
        {
            var bytes = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
            var status = (int)response.StatusCode;
            if (fault == Fault.ResetAfterStore)
            {
                Reset(socket);
                return false;
            }

            if (fault == Fault.EmptyAck && status == 202)
            {
                await WriteJsonAsync(stream, 202, new JsonObject(), null).ConfigureAwait(false);
                return true;
            }

            if (fault == Fault.PartialUnavailable && status == 202 && JsonNode.Parse(bytes) is JsonObject stored)
            {
                // The server stored the batch; report some stored events as unresolved so the client resends them and
                // the server's own deduplication is exercised.
                var ids = stored["ids"]!.AsArray().Select(n => n!.GetValue<string>()).ToList();
                var events = JsonNode.Parse(request.Body)!["events"]!.AsArray();
                var unresolved = new List<int>();
                for (var index = 0; index < events.Count; index++)
                {
                    var id = events[index]?["id"]?.GetValue<string>();
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
                        ["rejected"] = stored["rejected"]!.DeepClone(),
                        ["warnings"] = new JsonArray(),
                        ["indices"] = new JsonArray(unresolved.Select(i => (JsonNode?)JsonValue.Create(i)).ToArray()),
                        ["eventIds"] = new JsonArray(unresolved.Select(i => (JsonNode?)JsonValue.Create(events[i]!["id"]!.GetValue<string>())).ToArray()),
                    };
                    await WriteJsonAsync(stream, 503, Error("ingest_pending", "Some events need a retry; listed indices are unresolved.", details), "1").ConfigureAwait(false);
                    return true;
                }
            }

            var retryAfter = response.Headers.TryGetValues("Retry-After", out var values) ? values.FirstOrDefault() : null;
            await WriteRawAsync(stream, status, bytes, retryAfter).ConfigureAwait(false);
            return true;
        }
    }

    /// <summary>The server's per-event checks the stand-in mirrors (normalize.ts and eventInputSchema); null when valid.</summary>
    private static (string Code, string Reason)? Validate(JsonElement e)
    {
        if (e.ValueKind != JsonValueKind.Object)
        {
            return ("invalid_event", "invalid_event: event must be an object");
        }

        if (Encoding.UTF8.GetByteCount(e.GetRawText()) > MaxEventBytes)
        {
            return ("invalid_event", "invalid_event: event exceeds 256 KB");
        }

        if (!e.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String || !Guid.TryParse(id.GetString(), out _))
        {
            // The harness always sends a UUID id; anything else is a harness bug, refused like an invalid id.
            return ("invalid_event_id", "invalid_event_id: id must be valid Unicode, at most 256 UTF-16 code units, and contain no NUL");
        }

        if (!e.TryGetProperty("action", out var action) || action.ValueKind != JsonValueKind.String || action.GetString()!.Length is 0 or > 200)
        {
            return ("invalid_event", "invalid_event: action must be 1 to 200 characters");
        }

        return null;
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

    private Task WriteJsonAsync(NetworkStream stream, int status, JsonNode body, string? retryAfter)
    {
        var bytes = Encoding.UTF8.GetBytes(body.ToJsonString());
        _samples.Response(status, bytes);
        return WriteRawAsync(stream, status, bytes, retryAfter);
    }

    private static async Task WriteRawAsync(NetworkStream stream, int status, byte[] body, string? retryAfter)
    {
        var head = new StringBuilder();
        head.Append("HTTP/1.1 ").Append(status).Append(' ').Append(Reason(status)).Append(Crlf);
        head.Append("Content-Type: application/json").Append(Crlf);
        head.Append("Content-Length: ").Append(body.Length).Append(Crlf);
        if (retryAfter is not null)
        {
            head.Append("Retry-After: ").Append(retryAfter).Append(Crlf);
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
        404 => "Not Found",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Status",
    };

    private static long Fnv(string text)
    {
        unchecked
        {
            var hash = (long)14695981039346656037UL;
            foreach (var c in text)
            {
                hash = (hash ^ c) * 1099511628211L;
            }

            return hash;
        }
    }

    /// <summary>Reads one HTTP/1.1 request with a Content-Length body; null when the client closed the connection.</summary>
    private static async Task<HttpRequest?> ReadRequestAsync(NetworkStream stream)
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
            if (buffer.Count >= 4 && buffer[buffer.Count - 4] == HeaderEnd[0] && buffer[buffer.Count - 3] == HeaderEnd[1]
                && buffer[buffer.Count - 2] == HeaderEnd[2] && buffer[buffer.Count - 1] == HeaderEnd[3])
            {
                break;
            }

            if (buffer.Count > 64 * 1024)
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

        var length = headers.TryGetValue("content-length", out var text) && int.TryParse(text, out var n) ? n : 0;
        if (length > MaxBodyBytes + 1)
        {
            return null;
        }

        var body = new byte[length];
        var offset = 0;
        while (offset < length)
        {
            var read = await stream.ReadAsync(body, offset, length - offset).ConfigureAwait(false);
            if (read == 0)
            {
                return null;
            }

            offset += read;
        }

        var path = first.Length > 1 ? first[1] : "/";
        var query = path.IndexOf('?');
        return new HttpRequest(first[0], query >= 0 ? path.Substring(0, query) : path, headers, body);
    }

    private sealed class HttpRequest(string method, string path, Dictionary<string, string> headers, byte[] body)
    {
        public string Method { get; } = method;

        public string Path { get; } = path;

        public byte[] Body { get; } = body;

        public string? Header(string name) => headers.TryGetValue(name, out var value) ? value : null;
    }
}

/// <summary>
/// A bounded sample of what the stand-in answered and accepted, written as JSON Lines for
/// tests/cross-sdk/validate-stand-in.ts, which checks every line against packages/contracts.
/// </summary>
internal sealed class Samples
{
    private const int PerKind = 25;
    private readonly ConcurrentDictionary<string, int> _counts = new();
    private readonly ConcurrentQueue<string> _lines = new();

    public void Request(byte[] body) => Add("request", "{" + Quote("kind") + ":" + Quote("request") + "," + Quote("body") + ":" + Encoding.UTF8.GetString(body) + "}");

    public void Response(int status, byte[] body)
        => Add("response:" + status, "{" + Quote("kind") + ":" + Quote("response") + "," + Quote("status") + ":" + status + "," + Quote("body") + ":" + Encoding.UTF8.GetString(body) + "}");

    public void WriteTo(string path) => File.WriteAllLines(path, _lines);

    private void Add(string kind, string line)
    {
        if (_counts.AddOrUpdate(kind, 1, (_, n) => n + 1) <= PerKind)
        {
            _lines.Enqueue(line);
        }
    }

    private static string Quote(string text) => (char)34 + text + (char)34;
}
