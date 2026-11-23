using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
#if NETFRAMEWORK
using Logbird.Tests.Compat;
#endif

namespace Logbird.Tests;

/// <summary>A captured ingest request.</summary>
internal sealed class CapturedRequest(HttpRequestMessage request, byte[] body)
{
    // The client has no nesting limit of its own (the server has none for ordinary JSON), beyond the reader's default of 64.
    private static readonly JsonDocumentOptions Deep = new() { MaxDepth = 65_536 };

    public HttpRequestMessage Request { get; } = request;

    public byte[] Body { get; } = body;

    public string Text => Encoding.UTF8.GetString(Body);

    public JsonElement[] Events
    {
        get
        {
            using var document = JsonDocument.Parse(Body, Deep);
            return document.RootElement.GetProperty("events").EnumerateArray().Select(e => e.Clone()).ToArray();
        }
    }

    public string[] Ids => Events.Select(e => e.GetProperty("id").GetString()!).ToArray();

    /// <summary>Each event's raw JSON text, to prove retries are byte-identical.</summary>
    public string[] RawEvents
    {
        get
        {
            using var document = JsonDocument.Parse(Body, Deep);
            return document.RootElement.GetProperty("events").EnumerateArray().Select(e => e.GetRawText()).ToArray();
        }
    }

    public string? Header(string name)
        => Request.Headers.TryGetValues(name, out var values) ? string.Join(",", values) : null;
}

/// <summary>An in-process stand-in for the ingest endpoint. Each request is answered by the next scripted responder.</summary>
internal sealed class FakeServer : HttpMessageHandler
{
    private readonly ConcurrentQueue<Func<CapturedRequest, Task<HttpResponseMessage>>> _script = new();

    public ConcurrentQueue<CapturedRequest> Requests { get; } = new();

    /// <summary>Answers requests with no scripted response. Defaults to accepting everything.</summary>
    public Func<CapturedRequest, Task<HttpResponseMessage>> Fallback { get; set; } = request => Task.FromResult(Accept(request));

    public FakeServer Then(Func<CapturedRequest, HttpResponseMessage> responder)
    {
        _script.Enqueue(request => Task.FromResult(responder(request)));
        return this;
    }

    public FakeServer ThenAsync(Func<CapturedRequest, Task<HttpResponseMessage>> responder)
    {
        _script.Enqueue(responder);
        return this;
    }

    public FakeServer ThenStatus(HttpStatusCode status, string body = "{}", string? retryAfter = null)
        => Then(_ =>
        {
            var response = Json(status, body);
            if (retryAfter is not null)
            {
                response.Headers.TryAddWithoutValidation("Retry-After", retryAfter);
            }

            return response;
        });

    public static HttpResponseMessage Accept(CapturedRequest request, params (int Index, string Code)[] rejected)
    {
        var ids = request.Ids.Where((_, index) => rejected.All(r => r.Index != index)).ToArray();
        var body = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["accepted"] = ids.Length,
            ["ids"] = ids,
            ["rejected"] = rejected.Select(r => new Dictionary<string, object> { ["index"] = r.Index, ["reason"] = r.Code + ": fictional reason", ["code"] = r.Code }).ToArray(),
            ["warnings"] = Array.Empty<object>(),
        });
        return Json(HttpStatusCode.Accepted, body);
    }

    public static HttpResponseMessage Json(HttpStatusCode status, string body)
        => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(CancellationToken.None).ConfigureAwait(false);
        var captured = new CapturedRequest(request, body);
        Requests.Enqueue(captured);
        var responder = _script.TryDequeue(out var next) ? next : Fallback;
        var task = responder(captured);
        var cancelled = Task.Delay(Timeout.Infinite, cancellationToken);
        if (await Task.WhenAny(task, cancelled).ConfigureAwait(false) == cancelled)
        {
            throw new TaskCanceledException();
        }

        return await task.ConfigureAwait(false);
    }
}
