using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>Viewer tokens, facets and exports against a fake Logbird (docs/scoped-read-access.md).</summary>
public class ScopedReadTests
{
    private static readonly Uri Endpoint = new("https://audit.example.invalid");

    private static FakeServer Server(Func<CapturedRequest, HttpResponseMessage> route, string version = "0.2.0")
        => new()
        {
            Fallback = request => Task.FromResult(request.Request.RequestUri!.AbsolutePath == "/openapi.json"
                ? FakeServer.Json(HttpStatusCode.OK, "{\"info\":{\"version\":\"" + version + "\"}}")
                : route(request)),
        };

    private static LogbirdReadClient Reader(FakeServer server, string key = "lb_read_fictional")
        => new(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = key }, new HttpClient(server));

    private static int Calls(FakeServer server, string path) => server.Requests.Count(r => r.Request.RequestUri!.AbsolutePath == path);

    private static HttpResponseMessage Minted(CapturedRequest request)
    {
        using var body = JsonDocument.Parse(request.Body);
        var scope = body.RootElement.GetProperty("scope").GetRawText();
        return FakeServer.Json((HttpStatusCode)201, "{\"token\":\"lbv1.fictional.mac\",\"expiresAt\":\"2026-11-23T10:15:00.000Z\",\"scope\":" + scope + "}");
    }

    [Fact]
    public async Task Minting_sends_the_scope_and_lifetime_and_returns_a_token_that_never_prints()
    {
        var server = Server(Minted);
        using var reader = Reader(server);
        var scope = new ViewerScope("biz_5")
        {
            Target = new ViewerScopeTarget("website", "site_42"),
            ActionPrefixes = ["booking.", "auth."],
            Mask = ViewerMask.Ip | ViewerMask.ActorEmail,
        };
        var token = await reader.MintViewerTokenAsync(scope, TimeSpan.FromMinutes(10));

        var request = server.Requests.Single(r => r.Request.RequestUri!.AbsolutePath == "/v1/viewer-tokens");
        Assert.Equal(HttpMethod.Post, request.Request.Method);
        Assert.Equal("Bearer lb_read_fictional", request.Header("Authorization"));
        Assert.Equal(
            "{\"scope\":{\"tenantId\":\"biz_5\",\"target\":{\"type\":\"website\",\"id\":\"site_42\"},\"actionPrefixes\":[\"booking.\",\"auth.\"],\"mask\":[\"ip\",\"actor_email\"]},\"ttlSeconds\":600}",
            request.Text);
        Assert.Equal("lbv1.fictional.mac", token.Token);
        Assert.Equal(new DateTimeOffset(2026, 11, 23, 10, 15, 0, TimeSpan.Zero), token.ExpiresAt);
        Assert.Equal(ViewerMask.Ip | ViewerMask.ActorEmail, token.Scope.Mask);
        Assert.DoesNotContain("lbv1", token.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain("biz_5", token.Scope.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Without_a_lifetime_the_server_default_applies()
    {
        var server = Server(Minted);
        using var reader = Reader(server);
        await reader.MintViewerTokenAsync(new ViewerScope("biz_5"));
        Assert.Equal("{\"scope\":{\"tenantId\":\"biz_5\"}}", server.Requests.Single(r => r.Request.RequestUri!.AbsolutePath == "/v1/viewer-tokens").Text);
    }

    [Fact]
    public async Task Changing_the_prefix_list_after_calling_changes_nothing_that_is_sent_or_compared()
    {
        var prefixes = new System.Collections.Generic.List<string> { "booking." };
        var gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var server = new FakeServer
        {
            Fallback = async request =>
            {
                if (request.Request.RequestUri!.AbsolutePath == "/openapi.json")
                {
                    await gate.Task;
                    return FakeServer.Json(HttpStatusCode.OK, "{\"info\":{\"version\":\"0.2.0\"}}");
                }

                return Minted(request);
            },
        };
        using var reader = Reader(server);
        var minting = reader.MintViewerTokenAsync(new ViewerScope("biz_5") { ActionPrefixes = prefixes });

        // The caller changes its list while the version check is pending.
        prefixes.Add(" not validated ");
        gate.SetResult(true);
        var token = await minting;

        var sent = server.Requests.Single(r => r.Request.RequestUri!.AbsolutePath == "/v1/viewer-tokens").Text;
        Assert.Equal("{\"scope\":{\"tenantId\":\"biz_5\",\"actionPrefixes\":[\"booking.\"]}}", sent);
        Assert.Equal(["booking."], token.Scope.ActionPrefixes);
    }

    [Fact]
    public async Task A_granted_scope_that_differs_from_the_request_is_refused_and_the_token_withheld()
    {
        var server = Server(_ => FakeServer.Json((HttpStatusCode)201, "{\"token\":\"lbv1.fictional.mac\",\"expiresAt\":\"2026-11-23T10:15:00.000Z\",\"scope\":{\"tenantId\":\"biz_6\"}}"));
        using var reader = Reader(server);
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.MintViewerTokenAsync(new ViewerScope("biz_5")));
        Assert.Equal("scope_mismatch", error.Code);
        Assert.DoesNotContain("lbv1", error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_scope_wider_than_the_key_is_reported_with_the_servers_code()
    {
        var server = Server(_ => FakeServer.Json(HttpStatusCode.Forbidden, "{\"error\":{\"code\":\"scope_exceeded\",\"message\":\"fictional\"}}"));
        using var reader = Reader(server);
        Assert.Equal("scope_exceeded", (await Assert.ThrowsAsync<LogbirdApiException>(() => reader.MintViewerTokenAsync(new ViewerScope("biz_5")))).Code);
    }

    [Fact]
    public async Task Scopes_that_could_never_match_a_stored_id_fail_before_anything_is_sent()
    {
        var server = Server(Minted);
        using var reader = Reader(server);
        var bad = new[]
        {
            new ViewerScope(string.Empty),
            new ViewerScope(" biz_5"),
            new ViewerScope("biz_5 "),
            new ViewerScope(new string('t', 251)),
            new ViewerScope("biz" + (char)0xFFFD),
            new ViewerScope("biz" + (char)0xD800),
            new ViewerScope("biz_5") { Target = new ViewerScopeTarget(new string('w', 61), "site_42") },
            new ViewerScope("biz_5") { Target = new ViewerScopeTarget("website", string.Empty) },
            new ViewerScope("biz_5") { ActionPrefixes = [] },
            new ViewerScope("biz_5") { ActionPrefixes = Enumerable.Range(0, 21).Select(i => "a" + i).ToArray() },
            new ViewerScope("biz_5") { ActionPrefixes = [new string('p', 191)] },
            new ViewerScope("biz_5") { Mask = (ViewerMask)8 },
        };
        foreach (var scope in bad)
        {
            await Assert.ThrowsAsync<ArgumentException>(() => reader.MintViewerTokenAsync(scope));
        }

        await Assert.ThrowsAsync<ArgumentException>(() => reader.MintViewerTokenAsync(new ViewerScope("biz_5"), TimeSpan.FromSeconds(59)));
        await Assert.ThrowsAsync<ArgumentException>(() => reader.MintViewerTokenAsync(new ViewerScope("biz_5"), TimeSpan.FromSeconds(3601)));
        Assert.Empty(server.Requests);
    }

    [Fact]
    public async Task A_viewer_token_reads_like_a_key()
    {
        var server = Server(_ => FakeServer.Json(HttpStatusCode.OK, "{\"data\":[],\"nextCursor\":null,\"total\":0,\"tookMs\":1}"));
        using var reader = Reader(server, "lbv1.fictional.mac");
        await reader.SearchAsync(new EventSearch { Query = "action:booking.*" });
        Assert.Equal("Bearer lbv1.fictional.mac", server.Requests.Single().Header("Authorization"));
    }

    [Fact]
    public async Task Facets_send_the_field_split_and_limits_and_read_groups()
    {
        var server = Server(_ => FakeServer.Json(HttpStatusCode.OK,
            "{\"field\":\"action\",\"by\":\"outcome\",\"values\":[{\"value\":\"booking.created\",\"label\":\"booking.created\",\"count\":12,"
            + "\"groups\":[{\"value\":\"success\",\"label\":\"success\",\"count\":10}],\"groupsOtherCount\":2}],\"otherCount\":3}"));
        using var reader = Reader(server);
        var result = await reader.FacetsAsync(new FacetQuery("action") { By = "outcome", Limit = 20, ByLimit = 3, Query = "tenant:biz_5" });

        var query = server.Requests.Single(r => r.Request.RequestUri!.AbsolutePath == "/v1/facets").Request.RequestUri!.Query;
        Assert.Equal("?q=tenant%3Abiz_5&field=action&limit=20&by=outcome&byLimit=3", query);
        Assert.Equal("outcome", result.By);
        Assert.Equal(3, result.OtherCount);
        var value = Assert.Single(result.Values);
        Assert.Equal(12, value.Count);
        Assert.Equal(2, value.GroupsOtherCount);
        Assert.Equal("success", Assert.Single(value.Groups!).Value);
        Assert.DoesNotContain("booking", result.ToString(), StringComparison.Ordinal);
        await Assert.ThrowsAsync<ArgumentException>(() => reader.FacetsAsync(new FacetQuery("action") { Limit = 101 }));
        await Assert.ThrowsAsync<ArgumentException>(() => reader.FacetsAsync(new FacetQuery(string.Empty)));
    }

    [Fact]
    public async Task Exports_stream_into_the_destination()
    {
        var lines = string.Join("\n", Enumerable.Range(0, 2000).Select(i => "{\"id\":\"evt_" + i + "\"}")) + "\n";
        var server = Server(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(lines, Encoding.UTF8, "application/x-ndjson") });
        using var reader = Reader(server);
        using var file = new MemoryStream();
        var written = await reader.ExportAsync(new ExportQuery(ExportFormat.JsonlEvidence) { Query = "action:booking.*" }, file);

        Assert.Equal(Encoding.UTF8.GetByteCount(lines), written);
        Assert.Equal(lines, Encoding.UTF8.GetString(file.ToArray()));
        var request = server.Requests.Single(r => r.Request.RequestUri!.AbsolutePath == "/v1/export");
        Assert.Equal("?q=action%3Abooking.%2A&format=jsonl-evidence", request.Request.RequestUri!.Query);
        Assert.Equal("Bearer lb_read_fictional", request.Header("Authorization"));
    }

    [Fact]
    public async Task An_evidence_export_of_a_masked_scope_is_reported_with_the_servers_code()
    {
        var server = Server(_ => FakeServer.Json((HttpStatusCode)422, "{\"error\":{\"code\":\"masked_export\",\"message\":\"fictional\"}}"));
        using var reader = Reader(server, "lbv1.fictional.mac");
        using var file = new MemoryStream();
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.JsonlEvidence), file));
        Assert.Equal("masked_export", error.Code);
        Assert.Equal(0, file.Length);
    }

    [Fact]
    public async Task Servers_older_than_0_2_0_are_never_sent_these_requests()
    {
        var server = Server(_ => FakeServer.Json(HttpStatusCode.OK, "{}"), version: "0.1.3");
        using var reader = Reader(server);
        using var file = new MemoryStream();
        Assert.Equal("server_too_old", (await Assert.ThrowsAsync<LogbirdApiException>(() => reader.MintViewerTokenAsync(new ViewerScope("biz_5")))).Code);
        Assert.Equal("server_too_old", (await Assert.ThrowsAsync<LogbirdApiException>(() => reader.FacetsAsync(new FacetQuery("action")))).Code);
        Assert.Equal("server_too_old", (await Assert.ThrowsAsync<LogbirdApiException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Csv), file))).Code);
        Assert.Equal(0, Calls(server, "/v1/viewer-tokens") + Calls(server, "/v1/facets") + Calls(server, "/v1/export"));
    }
}
