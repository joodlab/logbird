using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>The eleven acceptance-bar items from the final review of the core SDK, one test or more each.</summary>
public class AcceptanceBarTests
{
    private static readonly Uri Endpoint = new("https://audit.example.invalid/");

    private static LogbirdOptions Options(Action<LogbirdOptions>? configure = null)
    {
        var options = new LogbirdOptions { Endpoint = Endpoint, IngestKey = "lb_ingest_fictional", FlushInterval = TimeSpan.FromHours(1) };
        configure?.Invoke(options);
        return options;
    }

    private static LogbirdClient Client(LogbirdOptions options, HttpMessageHandler handler)
        => new(options, new HttpClient(handler), logger: null, delay: (_, _) => Task.CompletedTask);

    // 1
    [Fact]
    public async Task A_success_without_an_acknowledgement_is_retried_and_never_counted_as_delivered()
    {
        var server = new FakeServer { Fallback = _ => Task.FromResult(FakeServer.Json(HttpStatusCode.OK, "{}")) };
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o =>
        {
            o.MaxRetries = 2;
            o.OnDrop = drops.Enqueue;
        }), server);
        client.Track(new AuditEvent("swallowed.by.gateway"));
        Assert.True(await client.FlushAsync());
        Assert.Equal(3, server.Requests.Count);
        Assert.Equal(server.Requests.First().Body, server.Requests.Last().Body);
        Assert.Equal(0, client.Stats.Delivered);
        Assert.Equal(DropReason.Unacknowledged, Assert.Single(drops).Reason);
    }

    [Fact]
    public async Task Only_events_the_response_names_count_and_the_rest_are_resent_byte_identically()
    {
        string[]? firstRaw = null;
        var server = new FakeServer().Then(request =>
        {
            firstRaw = request.RawEvents;
            return FakeServer.Json(HttpStatusCode.Accepted, JsonSerializer.Serialize(new { accepted = 1, ids = new[] { request.Ids[0] }, rejected = Array.Empty<object>() }));
        });
        await using var client = Client(Options(), server);
        client.Track(new AuditEvent("first"));
        client.Track(new AuditEvent("second"));
        Assert.True(await client.FlushAsync());
        Assert.Equal([firstRaw![1]], server.Requests.Last().RawEvents);
        Assert.Equal(2, client.Stats.Delivered);
    }

    // 2
    [Fact]
    public async Task An_evicted_event_is_accounted_before_any_flush_can_complete()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o =>
        {
            o.MaxQueueSize = 1;
            o.OnDrop = drops.Enqueue;
        }), new FakeServer());
        for (var round = 0; round < 200; round++)
        {
            var before = client.Stats.Dropped;
            client.Track(new AuditEvent("a"));
            client.Track(new AuditEvent("b"));
            Assert.True(await client.FlushAsync());
            Assert.Equal(before + 1, client.Stats.Dropped);
        }

        Assert.Equal(200, drops.Count);
    }

    // 3
    [Fact]
    public async Task Every_disposer_waits_for_the_same_shutdown_and_Track_is_rejected_at_once()
    {
        var server = new FakeServer { Fallback = async request =>
        {
            await Task.Delay(200);
            return FakeServer.Accept(request);
        } };
        var client = Client(Options(), server);
        for (var i = 0; i < 5; i++)
        {
            client.Track(new AuditEvent("queued"));
        }

        var first = client.DisposeAsync().AsTask();
        var second = client.DisposeAsync().AsTask();
        client.Track(new AuditEvent("after.dispose.started"));
        await second;
        Assert.True(first.IsCompleted);
        Assert.Equal(5, client.Stats.Delivered);
        client.Dispose();
    }

    // 4: covered byte for byte by CrossSdkTests (replacement and clearing hooks).

    // 5: a decided difference, not a defect.
    [Fact]
    public async Task Deliberate_number_differences_from_typescript_keep_the_exact_value()
    {
        var server = new FakeServer();
        await using var client = Client(Options(), server);
        using var parsed = JsonDocument.Parse("""{"tiny":1e-400,"big":123456789012345678901234567890}""");
        client.Track(new AuditEvent("numbers")
        {
            Metadata =
            {
                ["single"] = 1.1f,
                ["snowflake"] = 1_234_567_890_123_456_789L,
                ["money"] = 12345678901234.567890123456m,
                ["tiny"] = JsonValue.Create(parsed.RootElement.GetProperty("tiny")),
                ["big"] = JsonValue.Create(parsed.RootElement.GetProperty("big")),
            },
        });
        Assert.True(await client.FlushAsync());
        var text = server.Requests.Single().Text;

        // JavaScript would send 1.100000023841858, 1234567890123456800, 12345678901234.568, 0 and 1.2345678901234568e+29.
        Assert.Contains("\"single\":1.1,", text);
        Assert.Contains("\"snowflake\":1234567890123456789", text);
        Assert.Contains("\"money\":12345678901234.567890123456", text);
        Assert.Contains("\"tiny\":1e-400", text);
        Assert.Contains("\"big\":123456789012345678901234567890", text);
    }

    // 6
    [Fact]
    public async Task Identifier_fields_are_never_redacted_and_a_matching_pattern_is_reported_once_at_startup()
    {
        var errors = new ConcurrentQueue<Exception>();
        var server = new FakeServer();
        var options = Options(o => o.OnError = errors.Enqueue);
        options.Redaction.AddKeys("id", "email", "actor");
        await using var client = Client(options, server);
        client.Track(new AuditEvent("invoice.updated")
        {
            Actor = AuditActor.User("user_42", email: "fictional@example.invalid"),
            Tenant = new AuditTenant("acct_7"),
            Context = { RequestId = "req_1" },
            Metadata = { ["customerId"] = "c_9" },
        }.Target("invoice", "inv_1"));
        Assert.True(await client.FlushAsync());
        var e = server.Requests.Single().Events.Single();
        Assert.Equal("user_42", e.GetProperty("actor").GetProperty("id").GetString());
        Assert.Equal("[redacted]", e.GetProperty("actor").GetProperty("email").GetString());
        Assert.Equal("acct_7", e.GetProperty("tenant").GetProperty("id").GetString());
        Assert.Equal("inv_1", e.GetProperty("targets")[0].GetProperty("id").GetString());
        Assert.Equal("[redacted]", e.GetProperty("context").GetProperty("requestId").GetString());
        Assert.Equal("[redacted]", e.GetProperty("metadata").GetProperty("customerId").GetString());
        var report = Assert.Single(errors);
        Assert.Contains("never redacted", report.Message);
        Assert.Contains("pseudonymise", report.Message);
    }

    // 7
    [Fact]
    public async Task Diagnostics_carry_sdk_messages_and_type_names_never_raw_exception_or_response_text()
    {
        var errors = new ConcurrentQueue<Exception>();
        var server = new FakeServer()
            .Then(_ => throw new HttpRequestException("secret-in-handler-message"))
            .Then(request => FakeServer.Json(HttpStatusCode.Accepted,
                "{\"accepted\":0,\"ids\":[],\"rejected\":[{\"index\":0,\"reason\":\"x\",\"code\":\"Secret Code With Spaces\"}]}"));
        await using var client = Client(Options(o =>
        {
            o.MaxRetries = 0;
            o.OnError = errors.Enqueue;
            o.BeforeSend = e => e.Action == "hook.fails" ? throw new FormatException("secret-from-hook") : e;
        }), server);
        client.Track(new AuditEvent("hook.fails"));
        client.Track(new AuditEvent("network.fails"));
        Assert.False(await client.FlushAsync());
        Assert.True(await client.FlushAsync());
        Assert.All(errors, e =>
        {
            Assert.Null(e.InnerException);
            Assert.DoesNotContain("secret", e.Message, StringComparison.OrdinalIgnoreCase);
        });
        Assert.Contains(errors, e => e.Message.Contains(nameof(FormatException)));
        Assert.Contains(errors, e => e.Message.Contains(nameof(HttpRequestException)));
        Assert.Equal(["other"], errors.OfType<LogbirdRejectedException>().Single().Codes);

        var readServer = new FakeServer().ThenStatus(HttpStatusCode.BadRequest, """{"error":{"code":"bad_query","message":"secret value echoed"}}""");
        using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "k" }, new HttpClient(readServer));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync());
        Assert.DoesNotContain("secret", error.Message);
        Assert.Equal("secret value echoed", error.ServerMessage);
        Assert.Equal("bad_query", error.Code);
    }

    // 8
    [Fact]
    public void Records_print_no_values()
    {
        var actor = AuditActor.User("user_42", "Fictional User", "fictional@example.invalid");
        Assert.Equal("AuditActor { Type = user }", actor.ToString());
        Assert.DoesNotContain("acct", new AuditTenant("acct_7").ToString());
        Assert.DoesNotContain("inv_1", new AuditTarget("invoice", "inv_1") { Name = "INV-1" }.ToString());
        Assert.DoesNotContain("customer_9", new EventSearch { Query = "actor:customer_9" }.ToString());
        Assert.DoesNotContain("secret", new StoredChange("password", "secret", "secret").ToString());
    }

    // 9
    [Fact]
    public async Task An_oversized_event_is_dropped_before_it_is_copied_and_keeps_no_payload()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var copies = 0;
        await using var client = Client(Options(o =>
        {
            o.OnDrop = drops.Enqueue;
            o.BeforeSend = e =>
            {
                Interlocked.Increment(ref copies);
                return e;
            };
        }), new FakeServer());
        client.Track(new AuditEvent("huge") { Description = new string('x', 300 * 1024) });
        Assert.True(await client.FlushAsync());
        var drop = Assert.Single(drops);
        Assert.Equal(DropReason.TooLarge, drop.Reason);
        Assert.True(drop.Json.IsEmpty);
        Assert.Equal(0, copies);
    }

    [Fact]
    public async Task An_oversized_ingest_response_is_a_failure_not_an_unbounded_buffer()
    {
        var server = new FakeServer().Then(_ => FakeServer.Json(HttpStatusCode.Accepted, "{\"pad\":\"" + new string('x', 5 * 1024 * 1024) + "\"}"));
        await using var client = Client(Options(o => o.MaxRetries = 0), server);
        client.Track(new AuditEvent("x"));
        Assert.False(await client.FlushAsync());
        Assert.Equal(1, client.Stats.QueueLength);
        Assert.True(await client.FlushAsync());
    }

    // 10
    [Fact]
    public async Task Concurrent_flushes_for_the_same_events_share_one_waiter()
    {
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var server = new FakeServer().ThenAsync(async request =>
        {
            await release.Task;
            return FakeServer.Accept(request);
        });
        await using var client = Client(Options(), server);
        client.Track(new AuditEvent("shared"));
        using var cancel = new CancellationTokenSource();
        var flushes = Enumerable.Range(0, 500).Select(i => client.FlushAsync(i % 2 == 0 ? cancel.Token : CancellationToken.None)).ToArray();
        await Task.Delay(100);
        var waiters = typeof(Internal.EventQueue).GetField("_waiters", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;
        var queue = typeof(LogbirdClient).GetField("_queue", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(client)!;
        Assert.Single((System.Collections.ICollection)waiters.GetValue(queue)!);

        // Cancelling half the callers leaves the shared wait for the others.
        cancel.Cancel();
        await Task.Delay(100);
        Assert.Single((System.Collections.ICollection)waiters.GetValue(queue)!);
        release.SetResult(true);
        var results = await Task.WhenAll(flushes);
        Assert.Equal(250, results.Count(r => r));
    }

    [Fact]
    public async Task Pagination_remembers_a_bounded_window_of_cursors()
    {
        var page = 0;
        var server = new FakeServer
        {
            Fallback = _ =>
            {
                var next = Interlocked.Increment(ref page) < 1_500 ? $"\"c{page}\"" : "null";
                return Task.FromResult(FakeServer.Json(HttpStatusCode.OK, $$"""{"data":[],"nextCursor":{{next}},"total":0,"tookMs":1}"""));
            },
        };
        using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "k" }, new HttpClient(server));
        await foreach (var _ in reader.SearchAllAsync())
        {
        }

        Assert.Equal(1_500, page);
    }

    // 11
    [Fact]
    public void AddKeys_keeps_the_hosts_regex_timeout()
    {
        var options = new RedactionOptions { Keys = new Regex("secret", RegexOptions.None, TimeSpan.FromMilliseconds(50)) };
        options.AddKeys("email");
        Assert.Equal(TimeSpan.FromMilliseconds(50), options.Keys.MatchTimeout);
        Assert.Matches(options.Keys, "Email");
    }
}
