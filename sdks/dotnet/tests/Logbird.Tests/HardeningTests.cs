using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>Hostile handlers, listeners and inputs must not lose events, stall delivery or reach the host.</summary>
public class HardeningTests
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

    /// <summary>Never answers and ignores cancellation, but runs an optional cancellation callback.</summary>
    private sealed class HangingHandler(Action? onCancel = null) : HttpMessageHandler
    {
        public TaskCompletionSource<bool> Received { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int Requests;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Requests);
            if (onCancel is not null)
            {
                cancellationToken.Register(onCancel);
            }

            Received.TrySetResult(true);
            return new TaskCompletionSource<HttpResponseMessage>().Task;
        }
    }

    [Theory]
    [InlineData("http://audit.example.invalid")]
    [InlineData("https://audit.example.invalid/?region=eu")]
    [InlineData("https://audit.example.invalid/#x")]
    [InlineData("https://user:secret@audit.example.invalid/")]
    [InlineData("ftp://audit.example.invalid")]
    public void Unsafe_endpoints_are_rejected_at_startup(string endpoint)
    {
        Assert.Throws<ArgumentException>(() => new LogbirdClient(new LogbirdOptions { Endpoint = new Uri(endpoint), IngestKey = "k" }));
        Assert.Throws<ArgumentException>(() => new LogbirdReadClient(new LogbirdReadOptions { Endpoint = new Uri(endpoint), ReadKey = "k" }));
    }

    [Fact]
    public async Task Loopback_http_and_an_explicit_opt_in_are_allowed_and_path_prefixes_are_kept()
    {
        await using (new LogbirdClient(new LogbirdOptions { Endpoint = new Uri("http://localhost:4741"), IngestKey = "k" }))
        await using (new LogbirdClient(new LogbirdOptions { Endpoint = new Uri("http://127.0.0.1:4741"), IngestKey = "k" }))
        await using (new LogbirdClient(new LogbirdOptions { Endpoint = new Uri("http://logbird.internal"), IngestKey = "k", AllowInsecureHttp = true }))
        {
        }

        Assert.Equal("https://x.invalid/audit/v1/events", Internal.BatchSender.EventsUri(new Uri("https://x.invalid/audit")).AbsoluteUri);
        var server = new FakeServer().ThenStatus(HttpStatusCode.OK, """{"data":[],"nextCursor":null,"total":0,"tookMs":1}""");
        using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = new Uri("https://x.invalid/audit/"), ReadKey = "k" }, new HttpClient(server));
        await reader.SearchAsync(new EventSearch { Limit = 1 });
        Assert.Equal("https://x.invalid/audit/v1/events?limit=1", server.Requests.Single().Request.RequestUri!.AbsoluteUri);
    }

    [Fact]
    public async Task A_redirect_is_never_followed_and_drops_the_batch_as_a_permanent_error()
    {
        var server = new FakeServer().Then(_ =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.TemporaryRedirect);
            response.Headers.Location = new Uri("https://elsewhere.invalid/collect");
            return response;
        });
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o => o.OnDrop = drops.Enqueue), server);
        client.Track(new AuditEvent("redirected"));
        Assert.True(await client.FlushAsync());
        Assert.Single(server.Requests);
        Assert.Equal(DropReason.HttpError, Assert.Single(drops).Reason);
    }

    [Fact]
    public async Task A_throwing_metrics_listener_cannot_lose_events_or_reach_the_host()
    {
        using var listener = new MeterListener
        {
            InstrumentPublished = (instrument, l) =>
            {
                if (instrument.Meter.Name == "Logbird")
                {
                    l.EnableMeasurementEvents(instrument);
                }
            },
        };
        listener.SetMeasurementEventCallback<long>((_, _, _, _) => throw new InvalidOperationException("fictional broken exporter"));
        listener.Start();
        var server = new FakeServer();
        await using var client = Client(Options(o => o.MaxQueueSize = 2), server);
        for (var i = 0; i < 3; i++)
        {
            client.Track(new AuditEvent("measured"));
        }

        Assert.True(await client.FlushAsync());
        Assert.Equal(new LogbirdStats(3, 2, 0, 1, 0, 0, 0), client.Stats);
        Assert.Equal(2, server.Requests.SelectMany(r => r.Ids).Count());
    }

    [Fact]
    public async Task A_stuck_request_is_bounded_by_RequestTimeout_even_when_cancellation_is_ignored()
    {
        var handler = new HangingHandler();
        await using var client = Client(Options(o =>
        {
            o.RequestTimeout = TimeSpan.FromMilliseconds(150);
            o.MaxRetries = 1;
            o.ShutdownTimeout = TimeSpan.Zero;
        }), handler);
        client.Track(new AuditEvent("stuck"));
        var watch = Stopwatch.StartNew();
        Assert.False(await client.FlushAsync(TimeSpan.FromSeconds(20)));

        // The send failed on its own (the alternative is waiting out the flush's 20-second limit).
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(15), watch.Elapsed.ToString());
        Assert.Equal(1, client.Stats.FailedSends);
        Assert.Equal(2, handler.Requests);
        Assert.Equal(1, client.Stats.QueueLength);
    }

    [Fact]
    public async Task Shutdown_completes_when_a_cancellation_callback_throws()
    {
        var handler = new HangingHandler(() => throw new InvalidOperationException("fictional callback bug"));
        var drops = new ConcurrentQueue<DroppedEvent>();
        var client = Client(Options(o =>
        {
            o.ShutdownTimeout = TimeSpan.FromMilliseconds(200);
            o.OnDrop = drops.Enqueue;
        }), handler);
        client.Track(new AuditEvent("in.flight"));
        _ = client.FlushAsync();
        await handler.Received.Task;
        // The documented bound is ShutdownTimeout + 2 s (a cancelled request unwinding) + 5 s (pending callbacks); the
        // failure this test guards against is a hang, so the limit sits well above the bound.
        await Deadline.Within(TimeSpan.FromSeconds(15), () => client.DisposeAsync().AsTask());
        Assert.Equal(DropReason.Shutdown, Assert.Single(drops).Reason);
        Assert.Equal(0, client.Stats.QueueLength);
    }

    [Fact]
    public async Task Shutdown_completes_when_a_cancellation_callback_blocks()
    {
        using var block = new ManualResetEventSlim();
        var handler = new HangingHandler(() => block.Wait());
        var drops = new ConcurrentQueue<DroppedEvent>();
        var client = Client(Options(o =>
        {
            o.ShutdownTimeout = TimeSpan.FromMilliseconds(200);
            o.OnDrop = drops.Enqueue;
        }), handler);
        try
        {
            client.Track(new AuditEvent("in.flight"));
            client.Track(new AuditEvent("queued"));
            _ = client.FlushAsync();
            await handler.Received.Task;
            // Documented bound: ShutdownTimeout + 2 s + 5 s; the callback blocks forever, so a regression would hang.
            await Deadline.Within(TimeSpan.FromSeconds(15), () => client.DisposeAsync().AsTask());
            Assert.Equal(2, drops.Count(d => d.Reason == DropReason.Shutdown));
        }
        finally
        {
            block.Set();
        }
    }

    [Fact]
    public async Task A_later_failure_does_not_fail_a_flush_whose_events_were_all_settled()
    {
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var received = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var server = new FakeServer()
            .ThenAsync(async request =>
            {
                received.TrySetResult(true);
                await release.Task;
                return FakeServer.Accept(request);
            })
            .Then(request =>
            {
                // The batch holding e1 and e2: e1 is stored, e2 stays unresolved.
                var ids = request.Ids;
                var details = new { accepted = 1, ids = new[] { ids[0] }, rejected = Array.Empty<object>(), warnings = Array.Empty<object>(), indices = new[] { 1 }, eventIds = new[] { ids[1] } };
                return FakeServer.Json(HttpStatusCode.ServiceUnavailable, JsonSerializer.Serialize(new { error = new { code = "ingest_pending", details } }));
            })
            .ThenStatus(HttpStatusCode.ServiceUnavailable);
        await using var client = Client(Options(o => o.MaxRetries = 0), server);
        client.Track(new AuditEvent("e0"));
        var first = client.FlushAsync();
        await received.Task;
        client.Track(new AuditEvent("e1"));
        var flushA = client.FlushAsync();
        client.Track(new AuditEvent("e2"));
        var flushB = client.FlushAsync();
        release.SetResult(true);
        Assert.True(await first);
        Assert.True(await flushA);
        Assert.False(await flushB);
        Assert.Equal(1, client.Stats.QueueLength);
    }

    [Fact]
    public async Task Cancelled_flushes_are_forgotten()
    {
        var handler = new HangingHandler();
        await using var client = Client(Options(o => o.ShutdownTimeout = TimeSpan.Zero), handler);
        client.Track(new AuditEvent("pending"));
        for (var i = 0; i < 50; i++)
        {
            using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(5));
            Assert.False(await client.FlushAsync(cancel.Token));
        }

        var waiters = typeof(Internal.EventQueue).GetField("_waiters", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;
        var queue = typeof(LogbirdClient).GetField("_queue", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(client)!;
        Assert.Empty((System.Collections.ICollection)waiters.GetValue(queue)!);
    }

    [Fact]
    public async Task Huge_timeouts_mean_no_limit_instead_of_throwing()
    {
        await using var client = Client(Options(), new FakeServer());
        client.Track(new AuditEvent("patient"));
        Assert.True(await client.FlushAsync(TimeSpan.MaxValue));
        Assert.True(client.Flush(TimeSpan.MaxValue));
        Assert.Throws<ArgumentOutOfRangeException>(() => new LogbirdClient(Options(o => o.ShutdownTimeout = TimeSpan.FromDays(30))));
        Assert.Throws<ArgumentOutOfRangeException>(() => new LogbirdClient(Options(o => o.RequestTimeout = TimeSpan.Zero)));
    }

    [Fact]
    public async Task BeforeSend_cannot_change_the_callers_change_values()
    {
        var before = new JsonObject { ["limit"] = 24 };
        var original = new AuditEvent("limits.changed") { Changes = { new AuditChange("limits", before, new JsonObject { ["limit"] = 48 }) } };
        var server = new FakeServer();
        await using var client = Client(Options(o => o.BeforeSend = e =>
        {
            e.Changes[0].Before!["limit"] = 0;
            return e;
        }), server);
        client.Track(original);
        Assert.True(await client.FlushAsync());
        Assert.Equal(24, (int)before["limit"]!);
        Assert.Equal(0, server.Requests.Single().Events.Single().GetProperty("changes")[0].GetProperty("before").GetProperty("limit").GetInt32());
    }

    [Fact]
    public async Task Explicitly_empty_targets_and_changes_are_sent_and_untouched_ones_are_omitted()
    {
        var server = new FakeServer();
        await using var client = Client(Options(), server);
        client.Track(new AuditEvent("explicit") { Targets = new List<AuditTarget>(), Changes = new List<AuditChange>() });
        var untouched = new AuditEvent("untouched");
        _ = untouched.Targets.Count;
        client.Track(untouched);
        Assert.True(await client.FlushAsync());
        var events = server.Requests.Single().RawEvents;
        Assert.Contains("\"targets\":[],\"changes\":[]", events[0]);
        Assert.DoesNotContain("targets", events[1]);
    }

    [Theory]
    [InlineData("", null, null)]
    [InlineData(null, "", null)]
    [InlineData(null, null, "")]
    public void Empty_trail_selectors_are_rejected_instead_of_widening_the_search(string? targetId, string? actorId, string? tenantId)
        => Assert.Throws<ArgumentException>(() => EventSearch.ForTrail(targetId, actorId, tenantId));

    [Fact]
    public async Task A_cursor_that_does_not_advance_is_an_error_not_the_end()
    {
        var page = """{"data":[],"nextCursor":"c1","total":5,"tookMs":1}""";
        var server = new FakeServer().ThenStatus(HttpStatusCode.OK, page).ThenStatus(HttpStatusCode.OK, page);
        using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "k" }, new HttpClient(server));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(async () =>
        {
            await foreach (var _ in reader.SearchAllAsync())
            {
            }
        });
        Assert.Equal("pagination_stalled", error.Code);
    }
}
