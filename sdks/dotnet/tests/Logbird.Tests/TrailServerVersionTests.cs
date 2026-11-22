using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>
/// A trail that needs Logbird 0.2.0 (record:, or a trailing star or carriage return that older servers read differently)
/// is only sent to a server that reports 0.2.0 or later, and any other search is sent without asking.
/// </summary>
public class TrailServerVersionTests
{
    private static readonly Uri Endpoint = new("https://audit.example.invalid");

    private static FakeServer Server(string? version)
        => new()
        {
            Fallback = request => Task.FromResult(request.Request.RequestUri!.AbsolutePath == "/openapi.json"
                ? version is null
                    ? FakeServer.Json(HttpStatusCode.OK, "{\"openapi\":\"3.1.0\",\"info\":{}}")
                    : FakeServer.Json(HttpStatusCode.OK, "{\"openapi\":\"3.1.0\",\"info\":{\"version\":\"" + version + "\"}}")
                : FakeServer.Json(HttpStatusCode.OK, "{\"data\":[],\"nextCursor\":null,\"total\":0,\"tookMs\":1}")),
        };

    private static int Calls(FakeServer server, string path) => server.Requests.Count(r => r.Request.RequestUri!.AbsolutePath == path);

    [Theory]
    [InlineData("invoice", "inv_1", null)]
    [InlineData(null, "prefix*", null)]
    [InlineData(null, null, "carriage\rreturn")]
    public async Task A_trail_that_needs_0_2_0_is_never_sent_to_an_older_server(string? targetType, string? targetId, string? actorId)
    {
        var server = Server("0.1.3");
        using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "lb_read_fictional" }, new HttpClient(server));
        var search = EventSearch.ForTrail(targetId: targetId, actorId: actorId, targetType: targetType);

        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(search));
        Assert.Equal("server_too_old", error.Code);
        Assert.Equal(0, Calls(server, "/v1/events"));

        // The version request does not carry the read key.
        Assert.Null(server.Requests.Single(r => r.Request.RequestUri!.AbsolutePath == "/openapi.json").Request.Headers.Authorization);
    }

    [Fact]
    public async Task An_unreadable_server_version_fails_closed_and_is_asked_again_next_time()
    {
        var server = Server(null);
        using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "lb_read_fictional" }, new HttpClient(server));
        var search = EventSearch.ForTrail(targetId: "inv_1", targetType: "invoice");
        Assert.Equal("server_version_unknown", (await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(search))).Code);
        Assert.Equal("server_version_unknown", (await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(search))).Code);
        Assert.Equal(2, Calls(server, "/openapi.json"));
        Assert.Equal(0, Calls(server, "/v1/events"));
    }

    [Theory]
    [InlineData("0.2.0")]
    [InlineData("0.2.1-rc.1")]
    [InlineData("1.0.0")]
    public async Task A_current_server_runs_the_trail_and_its_version_is_read_once(string version)
    {
        var server = Server(version);
        using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "lb_read_fictional" }, new HttpClient(server));
        var search = EventSearch.ForTrail(targetId: "inv_1", targetType: "invoice");
        await reader.SearchAsync(search);
        await foreach (var _ in reader.SearchAllAsync(search))
        {
        }

        Assert.Equal(1, Calls(server, "/openapi.json"));
        Assert.Equal(2, Calls(server, "/v1/events"));
    }

    [Fact]
    public async Task Other_searches_never_ask_for_the_version()
    {
        var server = Server("0.1.3");
        using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "lb_read_fictional" }, new HttpClient(server));
        await reader.SearchAsync(EventSearch.ForTrail(targetId: "inv_1", actorId: "a*b", tenantId: "t"));
        await reader.SearchAsync(new EventSearch { Query = "action:invoice.*" });
        Assert.Equal(0, Calls(server, "/openapi.json"));
        Assert.Equal(2, Calls(server, "/v1/events"));
    }

    [Fact]
    public void The_eight_parameter_ForTrail_is_still_there_for_compiled_code_and_method_groups()
    {
        Func<string?, string?, string?, string?, DateTimeOffset?, DateTimeOffset?, int?, string?, EventSearch> eightParameters = EventSearch.ForTrail;
        var search = eightParameters("inv_1", null, null, null, null, null, 50, null);
        Assert.Equal("target:\"inv_1\"", search.Query);
        Assert.Equal(50, search.Limit);
    }

    [Fact]
    public void A_lone_low_surrogate_is_rejected_like_a_lone_high_one()
    {
        Assert.Throws<ArgumentException>(() => EventSearch.ForTrail(targetId: "a" + (char)0xDC00));
        Assert.Throws<ArgumentException>(() => EventSearch.ForTrail(targetId: "inv_1", targetType: (char)0xDC00 + "x"));
    }
}
