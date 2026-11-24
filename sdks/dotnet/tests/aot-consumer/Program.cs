// A Native AOT consumer of the packed Logbird and Logbird.AspNetCore packages (issue #322, B02). Each check runs one
// path that trimming or AOT compilation could break (source-generated JSON both ways, redaction, the ASP.NET Core
// integration on Kestrel, the job carrier, webhook verification) against an in-process stand-in for the server, so no
// network or Logbird server is needed. It prints one line per check and exits 1 on the first failure.
using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Logbird;
using Logbird.AspNetCore;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

var checks = 0;
try
{
    await TrackAndFlush();
    await ReadAPage();
    await AspNetCoreRequest();
    VerifyWebhook();
    Console.WriteLine($"AOT consumer: all {checks} checks passed");
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine($"AOT consumer: FAILED after {checks} checks: {error}");
    return 1;
}

void Pass(string what)
{
    checks++;
    Console.WriteLine($"ok {checks}: {what}");
}

void Expect(bool condition, string what)
{
    if (!condition)
    {
        throw new InvalidOperationException("expected " + what);
    }
}

// 1. The plain client serializes an event, redacts a secret, sends one batch and reads the acknowledgement.
async Task TrackAndFlush()
{
    var server = new StandIn();
    await using (var client = new LogbirdClient(new LogbirdOptions
    {
        Endpoint = new Uri("https://audit.example.invalid"),
        IngestKey = "lb_ingest_fictional",
        FlushInterval = TimeSpan.FromHours(1),
    }, new HttpClient(server)))
    {
        client.Track(new AuditEvent("invoice.updated")
        {
            Actor = AuditActor.User("user_42", name: "Fictional User"),
            Tenant = new AuditTenant("tenant_7"),
            Metadata = { ["plan"] = "pro", ["token"] = "fictional-secret", ["nested"] = new System.Text.Json.Nodes.JsonObject { ["depth"] = 2 } },
        }
        .Target("invoice", "inv_1", "INV-1")
        .Change("status", "draft", "sent"));
        Expect(await client.FlushAsync(), "FlushAsync to report every event settled");
        // FlushAsync is also true when an event was given up on, so the acknowledgement must have delivered it.
        var stats = client.Stats;
        Expect(stats.Delivered == 1 && stats.Dropped == 0 && stats.Rejected == 0, $"one delivered event and no drop (delivered {stats.Delivered}, dropped {stats.Dropped}, rejected {stats.Rejected})");
    }

    var sent = server.Events.Single();
    Expect(sent.GetProperty("action").GetString() == "invoice.updated", "the action to be sent");
    Expect(sent.GetProperty("actor").GetProperty("id").GetString() == "user_42", "the actor id to be sent");
    Expect(sent.GetProperty("tenant").GetProperty("id").GetString() == "tenant_7", "the tenant id to be sent");
    Expect(sent.GetProperty("targets")[0].GetProperty("id").GetString() == "inv_1", "the target to be sent");
    Expect(sent.GetProperty("changes")[0].GetProperty("after").GetString() == "sent", "the change to be sent");
    var metadata = sent.GetProperty("metadata");
    Expect(metadata.GetProperty("plan").GetString() == "pro", "ordinary metadata to be sent");
    Expect(metadata.GetProperty("token").GetString() == Redactor.DefaultReplacement, "metadata.token to be redacted");
    Expect(metadata.GetProperty("nested").GetProperty("depth").GetInt32() == 2, "nested metadata to be sent");
    Pass("Track and FlushAsync: serialized, redacted, acknowledged");
}

// 2. The read client deserializes a page of stored events.
async Task ReadAPage()
{
    const string stored = """
        {"id":"evt_1","projectId":"prj_1","timestamp":"2026-11-22T08:00:00.123Z","receivedAt":"2026-11-22T08:00:01.000Z",
         "environment":"staging","action":"invoice.updated","category":"invoice","outcome":"success","severity":"info",
         "description":"","actor":{"type":"user","id":"u1","name":"Fictional","email":""},"impersonator":null,
         "executor":{"type":"worker","id":"w","name":"","jobId":"j1","attempt":2},"tenant":{"id":"t1","name":""},"source":null,
         "targets":[{"type":"invoice","id":"inv_1","name":"INV-1"}],"changes":[{"field":"limit","before":"24","after":"48"}],
         "context":{"operationId":"op","parentEventId":"","requestId":"req","traceId":"","ip":"","userAgent":""},
         "attributes":{"metadata.plan":"pro"},"conformance":77.8,"schemaVersion":"","sdk":"dotnet/0.1.0"}
        """;
    var server = new StandIn(_ => StandIn.Json(HttpStatusCode.OK, $$"""{"data":[{{stored}}],"nextCursor":null,"total":1,"tookMs":3.5}"""));
    using var reader = new LogbirdReadClient(
        new LogbirdReadOptions { Endpoint = new Uri("https://audit.example.invalid"), ReadKey = "lb_read_fictional" },
        new HttpClient(server));
    var page = await reader.SearchAsync(new EventSearch { Query = "action:invoice.*", Limit = 10 });
    var read = page.Events.Single();
    Expect(read.Actor?.Id == "u1" && read.Executor?.JobId == "j1", "the parties to be read");
    Expect(read.Changes.Single().After == "48" && read.Attributes["metadata.plan"] == "pro", "changes and attributes to be read");
    Expect(page.Total == 1 && page.NextCursor is null, "the page fields to be read");
    Pass("LogbirdReadClient.SearchAsync: a stored event deserialized");
}

// 3. The ASP.NET Core integration on Kestrel: a request records an event with its context, hands out a carrier that
// round-trips as JSON, and the hosted client flushes it.
async Task AspNetCoreRequest()
{
    var server = new StandIn();
    var builder = WebApplication.CreateSlimBuilder();
    builder.WebHost.UseUrls("http://127.0.0.1:0");
    builder.Logging.ClearProviders();
    builder.Services.AddLogbird(o =>
    {
        o.Endpoint = new Uri("https://audit.example.invalid");
        o.IngestKey = "lb_ingest_fictional";
        o.FlushInterval = TimeSpan.FromHours(1);
    });
    builder.Services.AddHttpClient(LogbirdServiceCollectionExtensions.LogbirdHttpClientName).ConfigurePrimaryHttpMessageHandler(() => server);
    await using var app = builder.Build();
    app.UseLogbird();
    app.MapPost("/invoices/{id}", (string id, IAuditLog audit) =>
    {
        var eventId = audit.Record("invoice.sent", e => e.Target("invoice", id));
        return Results.Text(audit.Carrier(eventId).ToJson(), "application/json");
    });
    await app.StartAsync();
    try
    {
        using var http = new HttpClient { BaseAddress = new Uri(app.Urls.First()) };
        using var response = await http.PostAsync("/invoices/inv_9", content: null);
        Expect(response.StatusCode == HttpStatusCode.OK, $"the endpoint to answer 200, not {(int)response.StatusCode}");
        var carrier = AuditCarrier.FromJson(await response.Content.ReadAsStringAsync());
        Expect(!string.IsNullOrEmpty(carrier.OperationId) && !string.IsNullOrEmpty(carrier.ParentEventId), "the carrier to round-trip with its ids");

        var hosted = app.Services.GetRequiredService<ILogbirdClient>();
        Expect(await hosted.FlushAsync(), "the hosted client to flush");
        var stats = hosted.Stats;
        Expect(stats.Delivered == 1 && stats.Dropped == 0 && stats.Rejected == 0, $"one delivered event and no drop (delivered {stats.Delivered}, dropped {stats.Dropped}, rejected {stats.Rejected})");
        var sent = server.Events.Single();
        Expect(sent.GetProperty("action").GetString() == "invoice.sent", "the recorded action to be sent");
        Expect(sent.GetProperty("targets")[0].GetProperty("id").GetString() == "inv_9", "the route value to reach the event");
        Expect(sent.GetProperty("id").GetString() == carrier.ParentEventId, "the carrier to name the recorded event");
        Expect(sent.GetProperty("context").GetProperty("operationId").GetString() == carrier.OperationId, "the request context to be filled");
        Pass("ASP.NET Core on Kestrel: recorded in a request, carrier round-tripped, flushed");
    }
    finally
    {
        await app.StopAsync();
    }
}

// 4. Webhook signing and verification.
void VerifyWebhook()
{
    var secret = WebhookVerifier.GenerateSecret();
    const string payload = """{"type":"event.created","data":{"id":"evt_1"}}""";
    var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    var signature = WebhookVerifier.Sign("msg_1", timestamp, payload, secret);
    var verified = new WebhookVerifier(secret).Verify(payload, "msg_1", timestamp.ToString(System.Globalization.CultureInfo.InvariantCulture), signature);
    Expect(verified.GetProperty("data").GetProperty("id").GetString() == "evt_1", "the verified payload to be returned");
    try
    {
        new WebhookVerifier(secret).Verify(payload + " ", "msg_1", timestamp.ToString(System.Globalization.CultureInfo.InvariantCulture), signature);
        throw new InvalidOperationException("expected a tampered payload to be refused");
    }
    catch (WebhookVerificationException)
    {
    }

    Pass("WebhookVerifier: a signed payload verified, a tampered one refused");
}

/// <summary>An in-process stand-in for the Logbird server: it records each ingest batch and acknowledges every event.</summary>
internal sealed class StandIn(Func<HttpRequestMessage, HttpResponseMessage>? respond = null) : HttpMessageHandler
{
    private readonly ConcurrentQueue<JsonElement> _events = new();

    public JsonElement[] Events => _events.ToArray();

    public static HttpResponseMessage Json(HttpStatusCode status, string body)
        => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (respond is not null)
        {
            return respond(request);
        }

        var body = request.Content is null ? "{}" : await request.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        using var document = JsonDocument.Parse(body);
        var ids = new System.Collections.Generic.List<string>();
        foreach (var item in document.RootElement.GetProperty("events").EnumerateArray())
        {
            _events.Enqueue(item.Clone());
            ids.Add(item.GetProperty("id").GetString()!);
        }

        // The acknowledgement is written by hand: this app has no reflection-based serializer to lean on under AOT.
        var acknowledged = string.Join(",", ids.Select(id => JsonSerializer.Serialize(id, StandInJson.Default.String)));
        return Json(HttpStatusCode.Accepted, $$"""{"accepted":{{ids.Count}},"ids":[{{acknowledged}}],"rejected":[],"warnings":[]}""");
    }
}

[System.Text.Json.Serialization.JsonSerializable(typeof(string))]
internal sealed partial class StandInJson : System.Text.Json.Serialization.JsonSerializerContext
{
}
