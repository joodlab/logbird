using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
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

    private static readonly DateTimeOffset Expiry = new(2026, 11, 23, 10, 15, 0, TimeSpan.Zero);

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>A token shaped like the server's (<c>lbv1.&lt;payload&gt;.&lt;mac&gt;</c>), carrying a scope and expiry.</summary>
    private static string Envelope(string scopeJson, long? exp = null, string version = "1", string jti = "jti_fictional")
    {
        var expires = exp ?? Expiry.ToUnixTimeSeconds();
        var payload = $$"""{"v":{{version}},"kid":"key_fictional","p":"proj_fictional","s":{{scopeJson}},"iat":{{expires - 600}},"exp":{{expires}},"jti":"{{jti}}"}""";
        return "lbv1." + Base64Url(Encoding.UTF8.GetBytes(payload)) + "." + Mac;
    }

    /// <summary>A MAC of the server's length (32 bytes as unpadded base64url); the client cannot verify it, only its shape.</summary>
    private static readonly string Mac = Base64Url(Enumerable.Range(1, 32).Select(i => (byte)(i * 7)).ToArray());

    /// <summary>A jti whose base64url text contains '-' (a run of 0x7E gives sextet 62 at every alignment).</summary>
    private const string Tildes = "~~~~~~~~~~~~";

    /// <summary>A forgiving decode: standard or url alphabet, whitespace ignored, padding completed.</summary>
    private static string Lenient(string text)
    {
        var standard = text.Replace('-', '+').Replace('_', '/');
        var core = standard.Replace(" ", string.Empty).TrimEnd('=');
        return Convert.ToBase64String(Convert.FromBase64String(core + new string('=', (4 - (core.Length % 4)) % 4)));
    }

    /// <summary>The same token with its payload or MAC part changed.</summary>
    private static string Reshape(string token, Func<string, string>? payload = null, string? mac = null)
    {
        var parts = token.Split('.');
        return parts[0] + "." + (payload is null ? parts[1] : payload(parts[1])) + "." + (mac ?? parts[2]);
    }

    private static HttpResponseMessage Grant(string token, string scopeJson)
        => FakeServer.Json((HttpStatusCode)201, $$"""{"token":"{{token}}","expiresAt":"2026-11-23T10:15:00.000Z","scope":{{scopeJson}}}""");

    private static HttpResponseMessage Minted(CapturedRequest request)
    {
        using var body = JsonDocument.Parse(request.Body);
        var scope = body.RootElement.GetProperty("scope").GetRawText();
        return Grant(Envelope(scope), scope);
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
        Assert.Equal(Envelope("""{"tenantId":"biz_5","target":{"type":"website","id":"site_42"},"actionPrefixes":["booking.","auth."],"mask":["ip","actor_email"]}"""), token.Token);
        Assert.Equal(Expiry, token.ExpiresAt);
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
        const string other = """{"tenantId":"biz_6"}""";
        var server = Server(_ => Grant(Envelope(other), other));
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
            new ViewerScope("biz" + (char)0),
            new ViewerScope("biz_5") { Target = new ViewerScopeTarget("web" + (char)0 + "site", "site_42") },
            new ViewerScope("biz_5") { Target = new ViewerScopeTarget("website", "site" + (char)0) },
            new ViewerScope("biz_5") { ActionPrefixes = ["booking.", (char)0 + "auth."] },
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

    [Theory]
    [InlineData("0.2.0-rc.1")]
    [InlineData("0.2.0-0")]
    public async Task A_pre_release_of_0_2_0_is_not_0_2_0(string version)
    {
        var server = Server(_ => FakeServer.Json(HttpStatusCode.OK, "{}"), version);
        using var reader = Reader(server);
        using var file = new MemoryStream();
        Assert.Equal("server_too_old", (await Assert.ThrowsAsync<LogbirdApiException>(() => reader.MintViewerTokenAsync(new ViewerScope("biz_5")))).Code);
        Assert.Equal("server_too_old", (await Assert.ThrowsAsync<LogbirdApiException>(() => reader.FacetsAsync(new FacetQuery("action")))).Code);
        Assert.Equal("server_too_old", (await Assert.ThrowsAsync<LogbirdApiException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Csv), file))).Code);
        Assert.Equal(0, Calls(server, "/v1/viewer-tokens") + Calls(server, "/v1/facets") + Calls(server, "/v1/export"));
    }

    [Fact]
    public async Task A_credential_that_is_not_a_viewer_token_for_this_grant_is_never_returned()
    {
        const string scope = """{"tenantId":"biz_5"}""";
        var cases = new (string Token, string Code)[]
        {
            ("lb_read_fictionalkey", "invalid_response"),
            ("lbv1.not-base64!." + Mac, "invalid_response"),
            ("lbv1." + Base64Url(Encoding.UTF8.GetBytes("[]")) + "." + Mac, "invalid_response"),
            ("lbv1." + Base64Url(Encoding.UTF8.GetBytes(scope)) + "." + Mac, "invalid_response"),
            (Envelope(scope, version: "2"), "invalid_response"),
            (Envelope("""{"tenantId":"biz_6"}"""), "scope_mismatch"),
            (Envelope("""{"tenantId":"biz_5","mask":["ip"]}"""), "scope_mismatch"),
            (Envelope(scope, exp: Expiry.ToUnixTimeSeconds() + 3600), "scope_mismatch"),

            // Claims that match, in an envelope the server never produces (each payload is checked below to decode
            // leniently to the very same claims, so only the shape check can refuse it).
            (Reshape(Envelope(scope), payload: p => p.Insert(8, "    ")), "invalid_response"),
            (Reshape(Envelope(scope), payload: p => p + new string('=', (4 - (p.Length % 4)) % 4)), "invalid_response"),
            (Reshape(Envelope(scope, jti: Tildes), payload: p => p.Replace('-', '+').Replace('_', '/')), "invalid_response"),
            (Reshape(Envelope(scope), mac: "!"), "invalid_response"),
            (Reshape(Envelope(scope), mac: new string('!', 43)), "invalid_response"),
            (Reshape(Envelope(scope), mac: Mac.Remove(42)), "invalid_response"),
            (Reshape(Envelope(scope), mac: Mac + "A"), "invalid_response"),
            (Reshape(Envelope(scope), mac: Mac.Remove(42) + "="), "invalid_response"),
        };
        // The three reshaped payloads differ from the server's text, yet a lenient decoder reads the server's bytes.
        Assert.All(cases.Skip(8).Take(3), c =>
        {
            var payload = c.Token.Split('.')[1];
            var original = Envelope(scope, jti: c.Token == cases[10].Token ? Tildes : "jti_fictional").Split('.')[1];
            Assert.NotEqual(original, payload);
            Assert.Equal(Lenient(original), Lenient(payload));
        });

        foreach (var (token, code) in cases)
        {
            var server = Server(_ => Grant(token, scope));
            using var reader = Reader(server);
            var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.MintViewerTokenAsync(new ViewerScope("biz_5")));
            Assert.Equal(code, error.Code);
            Assert.DoesNotContain(token, error.ToString(), StringComparison.Ordinal);
        }
    }

    [Theory]
    [InlineData("""{"tenantId":"biz_5","target":{"type":"website","id":"site_42"},"tenantIds":["biz_6"]}""")]
    [InlineData("""{"tenantId":"biz_5","target":{"type":"website","id":"site_42","idPrefix":true}}""")]
    public async Task A_granted_scope_with_a_member_this_SDK_does_not_know_is_refused(string granted)
    {
        var server = Server(_ => Grant(Envelope(granted), granted));
        using var reader = Reader(server);
        var scope = new ViewerScope("biz_5") { Target = new ViewerScopeTarget("website", "site_42") };
        Assert.Equal("invalid_response", (await Assert.ThrowsAsync<LogbirdApiException>(() => reader.MintViewerTokenAsync(scope))).Code);
    }

    [Fact]
    public async Task The_largest_valid_scopes_are_sent_compactly_enough_for_the_servers_16_KB_limit()
    {
        // Each prefix is 190 UTF-16 units. The default .NET escaping (each < as six bytes, each emoji as twelve) would
        // send over 22 KB; written as JSON.stringify writes it, the request is well under the route's 16 KB limit.
        var suffix = Enumerable.Range(0, 20).Select(i => i.ToString("D2", CultureInfo.InvariantCulture)).ToArray();
        var sets = new[]
        {
            suffix.Select(s => new string('<', 188) + s).ToArray(),
            suffix.Select(s => string.Concat(Enumerable.Repeat("😀", 94)) + s).ToArray(),
        };
        foreach (var prefixes in sets)
        {
            var server = Server(Minted);
            using var reader = Reader(server);
            var scope = new ViewerScope(new string('t', 250))
            {
                Target = new ViewerScopeTarget(new string('w', 60), new string('i', 250)),
                ActionPrefixes = prefixes,
                Mask = ViewerMask.Ip | ViewerMask.UserAgent | ViewerMask.ActorEmail,
            };
            var token = await reader.MintViewerTokenAsync(scope, TimeSpan.FromHours(1));

            var sent = server.Requests.Single(r => r.Request.RequestUri!.AbsolutePath == "/v1/viewer-tokens").Body;
            Assert.True(sent.Length < 16 * 1024, "request bytes: " + sent.Length);
            using var parsed = JsonDocument.Parse(sent);
            Assert.Equal(prefixes, parsed.RootElement.GetProperty("scope").GetProperty("actionPrefixes").EnumerateArray().Select(p => p.GetString()));
            Assert.Equal(prefixes, token.Scope.ActionPrefixes);
        }
    }

    [Fact]
    public async Task Facets_accept_only_the_fields_and_lengths_the_server_does()
    {
        var server = Server(_ => FakeServer.Json(HttpStatusCode.OK, """{"field":"x","by":null,"values":[],"otherCount":0}"""));
        using var reader = Reader(server);
        var accepted = new[] { "action", "environment", "env", "actor.email", "occurredAt", "attr.metadata.plan", "attributes.a", "attr." + new string('p', 4096), "attributes." + new string('p', 4096) };
        foreach (var field in accepted)
        {
            await reader.FacetsAsync(new FacetQuery(field) { By = field });
        }

        var refused = new[] { "record", "nope", "Action", "attr.", "attributes.", "attr." + (char)10 + "x", "attr." + (char)0x2028, "attr." + new string('p', 4097), "attributes." + new string('p', 4097) };
        foreach (var field in refused)
        {
            await Assert.ThrowsAsync<ArgumentException>(() => reader.FacetsAsync(new FacetQuery(field)));
            await Assert.ThrowsAsync<ArgumentException>(() => reader.FacetsAsync(new FacetQuery("action") { By = field }));
        }

        await reader.FacetsAsync(new FacetQuery("action") { Query = new string('q', 4096) });
        await Assert.ThrowsAsync<ArgumentException>(() => reader.FacetsAsync(new FacetQuery("action") { Query = new string('q', 4097) }));
        using var file = new MemoryStream();
        await Assert.ThrowsAsync<ArgumentException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Csv) { Query = new string('q', 4097) }, file));
        Assert.Equal(accepted.Length + 1, Calls(server, "/v1/facets"));
        Assert.Equal(0, Calls(server, "/v1/export"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Cancelling_ends_an_export_whose_stream_ignores_cancellation(bool endsCleanlyWhenDisposed)
    {
        // Some streams fail their pending read when disposed; others report a clean end, which must not read as complete.
        var stalled = new StalledStream(Encoding.UTF8.GetBytes("""{"id":"evt_1"}""" + (char)10), endsCleanlyWhenDisposed);
        var server = Server(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(stalled) });
        using var reader = Reader(server);
        using var file = new MemoryStream();
        using var cancel = new CancellationTokenSource();
        var export = reader.ExportAsync(new ExportQuery(ExportFormat.Jsonl), file, cancel.Token);

        // The first line is written, then the download stalls in a read that ignores the token.
        await Deadline.Within(TimeSpan.FromSeconds(30), () => stalled.Stalled);
        cancel.Cancel();
        await Deadline.Within(TimeSpan.FromSeconds(30), () => Assert.ThrowsAnyAsync<OperationCanceledException>(() => export));
        Assert.True(file.Length > 0);
    }

    /// <summary>Returns its bytes, then stalls in a read that ignores cancellation and ends only when disposed.</summary>
    private sealed class StalledStream(byte[] first, bool endsCleanlyWhenDisposed) : Stream
    {
        private readonly TaskCompletionSource<int> _stall = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<bool> _stalled = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _sent;

        public Task Stalled => _stalled.Task;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult();

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            if (Interlocked.Exchange(ref _sent, 1) == 0)
            {
                Array.Copy(first, 0, buffer, offset, first.Length);
                return Task.FromResult(first.Length);
            }

            _stalled.TrySetResult(true);
            return _stall.Task;
        }

#if NET
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (Interlocked.Exchange(ref _sent, 1) == 0)
            {
                first.CopyTo(buffer);
                return new ValueTask<int>(first.Length);
            }

            _stalled.TrySetResult(true);
            return new ValueTask<int>(_stall.Task);
        }
#endif

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (endsCleanlyWhenDisposed)
            {
                _stall.TrySetResult(0);
            }
            else
            {
                _stall.TrySetException(new ObjectDisposedException(nameof(StalledStream)));
            }

            base.Dispose(disposing);
        }
    }
}
