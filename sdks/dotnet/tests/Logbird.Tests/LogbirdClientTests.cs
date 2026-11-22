using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Tests;

public class LogbirdClientTests
{
    private static readonly Uri Endpoint = new("https://audit.example.invalid/");

    private sealed class Harness : IAsyncDisposable
    {
        public Harness(Action<LogbirdOptions>? configure = null, FakeServer? server = null)
        {
            Server = server ?? new FakeServer();
            Options = new LogbirdOptions
            {
                Endpoint = Endpoint,
                IngestKey = "lb_ingest_fictional",
                FlushInterval = TimeSpan.FromHours(1),
                OnError = Errors.Enqueue,
                OnDrop = Drops.Enqueue,
            };
            configure?.Invoke(Options);
            Client = new LogbirdClient(Options, new HttpClient(Server), logger: null, delay: (wait, token) =>
            {
                Delays.Enqueue(wait);
                return Task.CompletedTask;
            });
        }

        public FakeServer Server { get; }

        public LogbirdOptions Options { get; }

        public LogbirdClient Client { get; }

        public ConcurrentQueue<Exception> Errors { get; } = new();

        public ConcurrentQueue<DroppedEvent> Drops { get; } = new();

        public ConcurrentQueue<TimeSpan> Delays { get; } = new();

        public CapturedRequest[] Requests => [.. Server.Requests];

        public ValueTask DisposeAsync() => Client.DisposeAsync();
    }

    private static AuditEvent Event(int n) => new AuditEvent($"record.updated").Target("record", $"rec_{n}");

    [Fact]
    public async Task Batches_by_size_and_sends_the_retry_capability_and_sdk_headers()
    {
        await using var h = new Harness(o => o.BatchSize = 100);
        for (var i = 0; i < 250; i++)
        {
            h.Client.Track(Event(i));
        }

        Assert.True(await h.Client.FlushAsync());
        Assert.Equal([100, 100, 50], h.Requests.Select(r => r.Events.Length));
        var first = h.Requests[0];
        Assert.Equal("https://audit.example.invalid/v1/events", first.Request.RequestUri!.ToString());
        Assert.Equal("Bearer lb_ingest_fictional", first.Request.Headers.Authorization!.ToString());
        Assert.Equal("subset", first.Header("Logbird-Retry"));
        Assert.StartsWith("dotnet/", first.Header("X-Logbird-SDK"));
        Assert.Equal(250, h.Client.Stats.Delivered);
        Assert.Equal(250, h.Requests.SelectMany(r => r.Ids).Distinct().Count());
    }

    [Fact]
    public async Task Sends_a_partial_batch_after_the_flush_interval()
    {
        await using var h = new Harness(o => o.FlushInterval = TimeSpan.FromMilliseconds(50));
        h.Client.Track(Event(1));
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (h.Client.Stats.Delivered == 0 && DateTime.UtcNow < deadline)
        {
            await Task.Delay(20);
        }

        Assert.Equal(1, h.Client.Stats.Delivered);
    }

    [Fact]
    public async Task Writes_the_envelope_with_uuidv7_ids_iso_timestamps_and_defaults()
    {
        await using var h = new Harness(o =>
        {
            o.Environment = "staging";
            o.Source = "billing-service";
        });
        h.Client.Track(new AuditEvent("invoice.updated")
        {
            Actor = AuditActor.User("user_42", "Fictional User", "fictional@example.invalid"),
            Impersonator = new AuditImpersonator("support_1") { Name = "Support" },
            Executor = AuditExecutor.Worker("billing-worker", jobId: "job_1", attempt: 2),
            Tenant = new AuditTenant("acct_7") { Name = "Fictional Co" },
            Outcome = AuditOutcome.Success,
            Severity = AuditSeverity.Notice,
            Description = "Fictional change",
            OccurredAt = new DateTimeOffset(2026, 11, 22, 10, 0, 0, 123, TimeSpan.FromHours(2)),
            Targets = { new AuditTarget("invoice", "inv_1") { Name = "INV-1" } },
            Changes = { new AuditChange("status", "draft", "sent"), new AuditChange("limit", 24, 48), AuditChange.Set("note", "new"), AuditChange.Removed("old", null) },
            Context = { OperationId = "op_1", RequestId = "req_1", TraceId = "4bf92f3577b34da6a3ce929d0e0e4736", Ip = "203.0.113.9", UserAgent = "test" },
            Metadata = { ["plan"] = "pro", ["seats"] = 3 },
        });
        Assert.True(await h.Client.FlushAsync());
        var e = h.Requests.Single().Events.Single();
        Assert.Matches("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", e.GetProperty("id").GetString());
        Assert.Equal("2026-11-22T08:00:00.123Z", e.GetProperty("occurredAt").GetString());
        Assert.Equal("staging", e.GetProperty("environment").GetString());
        Assert.Equal("billing-service", e.GetProperty("source").GetString());
        Assert.Equal("user", e.GetProperty("actor").GetProperty("type").GetString());
        Assert.Equal(2, e.GetProperty("executor").GetProperty("attempt").GetInt32());
        Assert.Equal("""[{"field":"status","before":"draft","after":"sent"},{"field":"limit","before":24,"after":48},{"field":"note","after":"new"},{"field":"old","before":null}]""", e.GetProperty("changes").GetRawText());
        Assert.Equal("op_1", e.GetProperty("context").GetProperty("operationId").GetString());
        Assert.Equal(3, e.GetProperty("metadata").GetProperty("seats").GetInt32());
    }

    [Fact]
    public async Task Takes_a_snapshot_and_never_reuses_an_id_for_the_same_instance()
    {
        await using var h = new Harness();
        var e = Event(1);
        h.Client.Track(e);
        e.Action = "changed.after.track";
        h.Client.Track(e);
        Assert.True(await h.Client.FlushAsync());
        var events = h.Requests.SelectMany(r => r.Events).ToArray();
        Assert.Equal("record.updated", events[0].GetProperty("action").GetString());
        Assert.NotEqual(events[0].GetProperty("id").GetString(), events[1].GetProperty("id").GetString());
        Assert.Null(e.Id);
    }

    [Fact]
    public async Task Redacts_secrets_by_default_and_can_add_personal_data_keys()
    {
        await using var h = new Harness(o => o.Redaction.AddKeys("email"));
        h.Client.Track(new AuditEvent("user.updated")
        {
            Actor = AuditActor.User("u1", email: "fictional@example.invalid"),
            Changes = { new AuditChange("password", "old", "new") },
            Metadata = { ["apiKey"] = "fictional", ["safe"] = "ok" },
        });
        Assert.True(await h.Client.FlushAsync());
        var e = h.Requests.Single().Events.Single();
        Assert.Equal("[redacted]", e.GetProperty("actor").GetProperty("email").GetString());
        Assert.Equal("[redacted]", e.GetProperty("changes")[0].GetProperty("before").GetString());
        Assert.Equal("[redacted]", e.GetProperty("metadata").GetProperty("apiKey").GetString());
        Assert.Equal("ok", e.GetProperty("metadata").GetProperty("safe").GetString());
    }

    [Fact]
    public async Task BeforeSend_sees_a_copy_can_filter_and_a_throwing_hook_drops_and_reports()
    {
        var seen = new List<string?>();
        await using var h = new Harness(o => o.BeforeSend = e =>
        {
            seen.Add(e.Id);
            if (e.Action == "health.checked")
            {
                return null;
            }

            if (e.Action == "boom")
            {
                throw new InvalidOperationException("fictional");
            }

            e.Metadata["enriched"] = true;
            e.Id = "  ";
            return e;
        });
        var original = Event(1);
        h.Client.Track(original);
        h.Client.Track(new AuditEvent("health.checked"));
        h.Client.Track(new AuditEvent("boom"));
        Assert.True(await h.Client.FlushAsync());
        var sent = h.Requests.Single().Events.Single();
        Assert.True(sent.GetProperty("metadata").GetProperty("enriched").GetBoolean());
        Assert.False(string.IsNullOrWhiteSpace(sent.GetProperty("id").GetString()));
        Assert.Empty(original.Metadata);
        Assert.All(seen, id => Assert.False(string.IsNullOrEmpty(id)));
        Assert.Equal(1, h.Client.Stats.Filtered);
        Assert.Equal(DropReason.Invalid, Assert.Single(h.Drops).Reason);
        Assert.Single(h.Errors);
    }

    [Fact]
    public async Task Retries_the_identical_body_after_a_503_without_details()
    {
        var server = new FakeServer().ThenStatus(HttpStatusCode.ServiceUnavailable).ThenStatus((HttpStatusCode)429, retryAfter: "2");
        await using var h = new Harness(server: server);
        for (var i = 0; i < 3; i++)
        {
            h.Client.Track(Event(i));
        }

        Assert.True(await h.Client.FlushAsync());
        Assert.Equal(3, h.Requests.Length);
        Assert.Equal(h.Requests[0].Body, h.Requests[1].Body);
        Assert.Equal(h.Requests[0].Body, h.Requests[2].Body);
        Assert.Equal(TimeSpan.FromSeconds(2), h.Delays.Last());
        Assert.Equal(3, h.Client.Stats.Delivered);
    }

    [Fact]
    public async Task A_rejected_event_does_not_block_its_batch_and_is_not_retried()
    {
        var server = new FakeServer().Then(request => FakeServer.Accept(request, (1, "invalid_event")));
        await using var h = new Harness(server: server);
        for (var i = 0; i < 3; i++)
        {
            h.Client.Track(Event(i));
        }

        Assert.True(await h.Client.FlushAsync());
        Assert.Single(h.Requests);
        var drop = Assert.Single(h.Drops);
        Assert.Equal(DropReason.Rejected, drop.Reason);
        Assert.Equal(h.Requests[0].Ids[1], drop.Id);
        Assert.Equal("invalid_event: fictional reason", drop.Detail);
        Assert.Contains("\"id\":\"" + drop.Id + "\"", drop.JsonText);
        Assert.Equal(new LogbirdStats(3, 2, 1, 0, 0, 0, 0), h.Client.Stats);
        var error = Assert.IsType<LogbirdRejectedException>(Assert.Single(h.Errors));
        Assert.Equal(["invalid_event"], error.Codes);
    }

    [Fact]
    public async Task Resends_only_unsettled_events_after_complete_503_details()
    {
        string[]? firstRaw = null;
        var server = new FakeServer().Then(request =>
        {
            firstRaw = request.RawEvents;
            var ids = request.Ids;
            var details = new
            {
                accepted = 1,
                ids = new[] { ids[0] },
                rejected = new[] { new { index = 1, reason = "invalid_event: fictional", code = "invalid_event" } },
                warnings = Array.Empty<object>(),
                indices = new[] { 2, 3 },
                eventIds = new[] { ids[2], ids[3] },
            };
            var response = FakeServer.Json(HttpStatusCode.ServiceUnavailable, JsonSerializer.Serialize(new { error = new { code = "ingest_pending", message = "pending", details } }));
            response.Headers.TryAddWithoutValidation("Retry-After", "1");
            return response;
        });
        await using var h = new Harness(o => o.MaxRetries = 0, server);
        for (var i = 0; i < 4; i++)
        {
            h.Client.Track(Event(i));
        }

        Assert.True(await h.Client.FlushAsync());
        Assert.Equal(2, h.Requests.Length);
        Assert.Equal([firstRaw![2], firstRaw[3]], h.Requests[1].RawEvents);
        Assert.Equal(DropReason.Rejected, Assert.Single(h.Drops).Reason);
        Assert.Equal(3, h.Client.Stats.Delivered);
        Assert.Equal(TimeSpan.FromSeconds(1), Assert.Single(h.Delays));
    }

    [Fact]
    public async Task Keeps_the_previous_body_when_503_details_are_incomplete()
    {
        var server = new FakeServer().Then(request =>
        {
            var ids = request.Ids;
            var details = new { accepted = 1, ids = new[] { ids[0] }, rejected = Array.Empty<object>(), indices = new[] { 1 }, eventIds = new[] { "not-the-id" }, warnings = Array.Empty<object>() };
            return FakeServer.Json(HttpStatusCode.ServiceUnavailable, JsonSerializer.Serialize(new { error = new { code = "ingest_pending", details } }));
        });
        await using var h = new Harness(server: server);
        h.Client.Track(Event(0));
        h.Client.Track(Event(1));
        Assert.True(await h.Client.FlushAsync());
        Assert.Equal(h.Requests[0].Body, h.Requests[1].Body);
    }

    [Fact]
    public async Task A_permanent_http_error_drops_the_batch_and_continues()
    {
        var server = new FakeServer().ThenStatus(HttpStatusCode.Unauthorized, """{"error":{"code":"unauthorized","message":"no"}}""");
        await using var h = new Harness(o => o.BatchSize = 2, server);
        for (var i = 0; i < 3; i++)
        {
            h.Client.Track(Event(i));
        }

        Assert.True(await h.Client.FlushAsync());
        Assert.Equal(2, h.Drops.Count);
        Assert.All(h.Drops, d => Assert.Equal(DropReason.HttpError, d.Reason));
        Assert.Equal(1, h.Client.Stats.Delivered);
        Assert.Equal(HttpStatusCode.Unauthorized, Assert.IsType<LogbirdDeliveryException>(Assert.Single(h.Errors)).StatusCode);
    }

    [Fact]
    public async Task Exhausted_retries_keep_events_queued_and_a_later_flush_delivers_them_once()
    {
        var server = new FakeServer();
        server.Fallback = _ => Task.FromResult(FakeServer.Json(HttpStatusCode.BadGateway, "{}"));
        await using var h = new Harness(o => o.MaxRetries = 2, server);
        for (var i = 0; i < 5; i++)
        {
            h.Client.Track(Event(i));
        }

        Assert.False(await h.Client.FlushAsync());
        Assert.Equal(3, h.Requests.Length);
        Assert.Equal(5, h.Client.Stats.QueueLength);
        Assert.Equal(1, h.Client.Stats.FailedSends);
        var ids = h.Requests[0].Ids;

        server.Fallback = request => Task.FromResult(FakeServer.Accept(request));
        Assert.True(await h.Client.FlushAsync());
        Assert.Equal(ids, h.Requests.Last().Ids);
        Assert.Equal(h.Requests[0].Body, h.Requests.Last().Body);
        Assert.Equal(5, h.Client.Stats.Delivered);
        Assert.Equal(0, h.Client.Stats.QueueLength);
    }

    [Fact]
    public async Task Network_errors_are_retried()
    {
        var server = new FakeServer().Then(_ => throw new HttpRequestException("fictional network failure"));
        await using var h = new Harness(server: server);
        h.Client.Track(Event(1));
        Assert.True(await h.Client.FlushAsync());
        Assert.Equal(2, h.Requests.Length);
        Assert.Equal(1, h.Client.Stats.Delivered);
    }

    [Theory]
    [InlineData(QueueFullBehavior.DropOldest, 2, 4)]
    [InlineData(QueueFullBehavior.DropNewest, 0, 2)]
    public async Task A_full_queue_drops_and_counts_without_throwing(QueueFullBehavior behavior, int firstKept, int lastKept)
    {
        var server = new FakeServer();
        await using var h = new Harness(
            o =>
            {
                o.MaxQueueSize = 3;
                o.QueueFullBehavior = behavior;
            },
            server);
        for (var i = 0; i < 5; i++)
        {
            h.Client.Track(Event(i));
        }

        Assert.Equal(2, h.Client.Stats.Dropped);
        Assert.All(h.Drops, d => Assert.Equal(DropReason.QueueFull, d.Reason));
        Assert.True(await h.Client.FlushAsync());
        var targets = h.Requests.SelectMany(r => r.Events).Select(e => e.GetProperty("targets")[0].GetProperty("id").GetString()).ToArray();
        Assert.Equal(Enumerable.Range(firstKept, lastKept - firstKept + 1).Select(i => $"rec_{i}"), targets);
    }

    [Fact]
    public async Task Oversized_events_are_dropped_and_reported()
    {
        await using var h = new Harness();
        h.Client.Track(new AuditEvent("big") { Metadata = { ["blob"] = new string('x', 300 * 1024) } });
        Assert.True(await h.Client.FlushAsync());
        Assert.Empty(h.Requests);
        Assert.Equal(DropReason.TooLarge, Assert.Single(h.Drops).Reason);
    }

    [Fact]
    public async Task Track_never_throws_even_when_callbacks_throw()
    {
        await using var h = new Harness(o =>
        {
            o.MaxQueueSize = 1;
            o.OnDrop = _ => throw new InvalidOperationException("fictional");
            o.OnError = _ => throw new InvalidOperationException("fictional");
        });
        h.Client.Track(null!);
        h.Client.Track(Event(1));
        h.Client.Track(Event(2));
        h.Client.Track(new AuditEvent("x") { Changes = { null! }, Targets = { null! } });
        Assert.True(await h.Client.FlushAsync());
        Assert.Equal(1, h.Client.Stats.Delivered);
    }

    [Fact]
    public async Task Dispose_flushes_what_is_queued_and_later_tracks_are_dropped()
    {
        var h = new Harness();
        for (var i = 0; i < 7; i++)
        {
            h.Client.Track(Event(i));
        }

        await h.Client.DisposeAsync();
        Assert.Equal(7, h.Client.Stats.Delivered);
        h.Client.Track(Event(8));
        Assert.Equal(DropReason.Shutdown, Assert.Single(h.Drops).Reason);
        Assert.True(await h.Client.FlushAsync());
        await h.Client.DisposeAsync();
    }

    [Fact]
    public async Task Dispose_gives_up_after_the_shutdown_timeout_and_reports_every_unsent_event()
    {
        var server = new FakeServer();
        server.Fallback = _ => new TaskCompletionSource<HttpResponseMessage>().Task;
        var h = new Harness(o => o.ShutdownTimeout = TimeSpan.FromMilliseconds(300), server);
        for (var i = 0; i < 4; i++)
        {
            h.Client.Track(Event(i));
        }

        var started = DateTime.UtcNow;
        await h.Client.DisposeAsync();
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(5));
        Assert.Equal(4, h.Drops.Count(d => d.Reason == DropReason.Shutdown));
        Assert.Equal(0, h.Client.Stats.QueueLength);
    }

    [Fact]
    public async Task FlushAsync_returns_false_when_cancelled()
    {
        var server = new FakeServer();
        server.Fallback = _ => new TaskCompletionSource<HttpResponseMessage>().Task;
        var h = new Harness(o => o.ShutdownTimeout = TimeSpan.FromMilliseconds(100), server);
        h.Client.Track(Event(1));
        using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        Assert.False(await h.Client.FlushAsync(cancel.Token));
        await h.Client.DisposeAsync();
    }

    [Fact]
    public async Task A_disabled_client_needs_no_endpoint_and_does_nothing()
    {
        await using var client = new LogbirdClient(new LogbirdOptions { Enabled = false });
        client.Track(Event(1));
        Assert.True(await client.FlushAsync());
        Assert.Equal(default, client.Stats);
    }

    [Fact]
    public void Invalid_options_fail_fast_at_startup()
    {
        Assert.Throws<ArgumentException>(() => new LogbirdClient(new LogbirdOptions()));
        Assert.Throws<ArgumentException>(() => new LogbirdClient(new LogbirdOptions { Endpoint = Endpoint }));
        Assert.Throws<ArgumentException>(() => new LogbirdClient(new LogbirdOptions { Endpoint = new Uri("ftp://x.invalid"), IngestKey = "k" }));
        Assert.Throws<ArgumentOutOfRangeException>(() => new LogbirdClient(new LogbirdOptions { Endpoint = Endpoint, IngestKey = "k", BatchSize = 1001 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => new LogbirdClient(new LogbirdOptions { Endpoint = Endpoint, IngestKey = "k", MaxQueueSize = 0 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => new LogbirdClient(new LogbirdOptions { Endpoint = Endpoint, IngestKey = "k", MaxRetries = -1 }));
    }

    [Fact]
    public void Endpoint_paths_are_kept()
        => Assert.Equal("https://x.invalid/audit/v1/events", Internal.BatchSender.EventsUri(new Uri("https://x.invalid/audit/")).ToString());

    [Fact]
    public void Event_ids_are_time_ordered_uuidv7()
    {
        Assert.Matches("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", LogbirdClient.NewEventId());
        var earlier = Internal.UuidV7.Format(1_721_000_000_000);
        var later = Internal.UuidV7.Format(1_721_000_000_001);
        Assert.True(string.CompareOrdinal(earlier, later) < 0);
        Assert.Equal("0190b397-fa00", Internal.UuidV7.Format(1_721_000_000_000).Substring(0, 13));
    }

    [Fact]
    public void JsTrim_matches_javascript()
    {
        Assert.Equal("a", Internal.EventJson.JsTrim("\uFEFF\u00A0 a\u3000\n"));
        Assert.Equal("\u0085a", Internal.EventJson.JsTrim("\u0085a"));
    }
}
