using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;

namespace Logbird.Tests;

public class LogbirdReadClientTests
{
    private const string StoredEventJson = """
        {"id":"evt_1","projectId":"prj_1","timestamp":"2026-11-22T08:00:00.123Z","receivedAt":"2026-11-22T08:00:01.000Z",
         "environment":"staging","action":"invoice.updated","category":"invoice","outcome":"success","severity":"info",
         "description":"","actor":{"type":"user","id":"u1","name":"Fictional","email":""},"impersonator":null,
         "executor":{"type":"worker","id":"w","name":"","jobId":"j1","attempt":2},"tenant":{"id":"t1","name":""},"source":null,
         "targets":[{"type":"invoice","id":"inv_1","name":"INV-1"}],"changes":[{"field":"limit","before":"24","after":"48"}],
         "context":{"operationId":"op","parentEventId":"","requestId":"req","traceId":"","ip":"","userAgent":""},
         "attributes":{"metadata.plan":"pro"},"conformance":77.8,"schemaVersion":"","sdk":"dotnet/0.1.0"}
        """;

    private static LogbirdReadClient Client(FakeServer server)
        => new(new LogbirdReadOptions { Endpoint = new Uri("https://audit.example.invalid"), ReadKey = "lb_read_fictional" }, new HttpClient(server));

    [Fact]
    public async Task Searches_with_an_encoded_query_and_reads_every_field()
    {
        var server = new FakeServer().Then(_ => FakeServer.Json(HttpStatusCode.OK, $$"""{"data":[{{StoredEventJson}}],"nextCursor":null,"total":1,"tookMs":3.5}"""));
        using var client = Client(server);
        var page = await client.SearchAsync(new EventSearch
        {
            Query = "action:invoice.* actor:\"u 1\"",
            From = new DateTimeOffset(2026, 11, 1, 0, 0, 0, TimeSpan.Zero),
            Limit = 10,
            Order = SortOrder.Ascending,
        });
        var request = server.Requests.Single().Request;
        Assert.Equal(
            "https://audit.example.invalid/v1/events?from=2026-11-01T00%3A00%3A00.000Z&q=action%3Ainvoice.%2A%20actor%3A%22u%201%22&limit=10&order=asc",
            request.RequestUri!.AbsoluteUri);
        Assert.Equal("Bearer lb_read_fictional", request.Headers.Authorization!.ToString());
        var e = Assert.Single(page.Events);
        Assert.Equal(new DateTimeOffset(2026, 11, 22, 8, 0, 0, 123, TimeSpan.Zero), e.Timestamp);
        Assert.Equal(AuditActor.User("u1", "Fictional", string.Empty), e.Actor);
        Assert.Null(e.Impersonator);
        Assert.Equal(2, e.Executor!.Attempt);
        Assert.Equal(new AuditTarget("invoice", "inv_1") { Name = "INV-1" }, e.Targets.Single());
        Assert.Equal(new StoredChange("limit", "24", "48"), e.Changes.Single());
        Assert.Equal("op", e.Context.OperationId);
        Assert.Equal("pro", e.Attributes["metadata.plan"]);
        Assert.Null(page.NextCursor);
    }

    [Fact]
    public async Task Reads_change_kinds_when_present()
    {
        var typed = StoredEventJson.Replace(
            """{"field":"limit","before":"24","after":"48"}""",
            """{"field":"limit","before":"","after":"null","beforeKind":"absent","afterKind":"null"}""");
        var server = new FakeServer().Then(_ => FakeServer.Json(HttpStatusCode.OK, $$"""{"data":[{{typed}}],"nextCursor":null,"total":1,"tookMs":1}"""));
        using var client = Client(server);
        var page = await client.SearchAsync();
        Assert.Equal(new StoredChange("limit", "", "null") { BeforeKind = "absent", AfterKind = "null" }, Assert.Single(page.Events.Single().Changes));
    }

    [Fact]
    public async Task Gets_one_event_and_returns_null_for_404()
    {
        var server = new FakeServer()
            .Then(_ => FakeServer.Json(HttpStatusCode.OK, $$"""{"event":{{StoredEventJson}},"payload":{"id":"evt_1","action":"invoice.updated"},"parents":[],"childCount":2,"operationSize":5}"""))
            .ThenStatus(HttpStatusCode.NotFound, """{"error":{"code":"not_found","message":"Event not found"}}""");
        using var client = Client(server);
        var detail = await client.GetEventAsync("evt/1");
        Assert.Equal("evt_1", detail!.Event.Id);
        Assert.Equal("invoice.updated", detail.Payload.GetProperty("action").GetString());
        Assert.Equal(5, detail.OperationSize);
        Assert.EndsWith("/v1/events/evt%2F1", server.Requests.First().Request.RequestUri!.AbsoluteUri);
        Assert.Null(await client.GetEventAsync("missing"));
    }

    [Fact]
    public async Task Errors_carry_the_logbird_code()
    {
        var server = new FakeServer().ThenStatus((HttpStatusCode)429, """{"error":{"code":"rate_limited","message":"Too many requests"}}""");
        using var client = Client(server);
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => client.SearchAsync());
        Assert.Equal((HttpStatusCode)429, error.StatusCode);
        Assert.Equal("rate_limited", error.Code);
    }

    [Fact]
    public async Task SearchAll_follows_cursors()
    {
        var server = new FakeServer()
            .Then(_ => FakeServer.Json(HttpStatusCode.OK, $$"""{"data":[{{StoredEventJson}}],"nextCursor":"c2","total":2,"tookMs":1}"""))
            .Then(_ => FakeServer.Json(HttpStatusCode.OK, $$"""{"data":[{{StoredEventJson}}],"nextCursor":null,"total":2,"tookMs":1}"""));
        using var client = Client(server);
        var count = 0;
        await foreach (var _ in client.SearchAllAsync(new EventSearch { Limit = 1 }))
        {
            count++;
        }

        Assert.Equal(2, count);
        Assert.Contains("cursor=c2", server.Requests.Last().Request.RequestUri!.Query);
    }

    [Fact]
    public void Trail_queries_quote_selectors_for_the_query_language()
    {
        var search = EventSearch.ForTrail(targetId: "a" + '"' + " OR actor:other", query: "action:record.* OR action:other");
        Assert.Equal("(action:record.* OR action:other) AND target:" + '"' + "a" + '\\' + '"' + " OR actor:other" + '"', search.Query);
        Assert.Equal("target:" + '"' + "inv" + '"' + " AND actor:" + '"' + "u" + '"' + " AND tenant:" + '"' + "t" + '"', EventSearch.ForTrail("inv", "u", "t").Query);

        // Inside quotes the query language takes a backslashed character literally, so a tab is sent as a tab.
        Assert.Equal('"' + "a" + (char)9 + "b" + '\\' + '\\' + '"', EventSearch.Quote("a" + (char)9 + "b" + '\\'));
    }
}
