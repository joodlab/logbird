using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>
/// <see cref="DroppedEvent.MayBeStored"/> follows what happened on the wire, not the drop reason: true once a request
/// carrying the event started and no answer settled it; false when the event was never sent or every answer said it was
/// not stored.
/// </summary>
public class MayBeStoredTests
{
    private static readonly Uri Endpoint = new("https://audit.example.invalid/");

    private static LogbirdOptions Options(ConcurrentQueue<DroppedEvent> drops, Action<LogbirdOptions>? configure = null)
    {
        var options = new LogbirdOptions
        {
            Endpoint = Endpoint,
            IngestKey = "lb_ingest_fictional",
            FlushInterval = TimeSpan.FromHours(1),
            OnDrop = drops.Enqueue,
        };
        configure?.Invoke(options);
        return options;
    }

    private static LogbirdClient Client(LogbirdOptions options, HttpMessageHandler handler)
        => new(options, new HttpClient(handler), logger: null, delay: (_, _) => Task.CompletedTask);

    private static HttpResponseMessage Lost(CapturedRequest request) => throw new HttpRequestException("fictional connection reset");

    private static async Task WithinAsync(Task task, string what)
    {
        if (await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(30))).ConfigureAwait(false) != task)
        {
            throw new TimeoutException(what + " did not happen within 30 s");
        }

        await task.ConfigureAwait(false);
    }

    /// <summary>Never answers and ignores cancellation, so the sender has to abandon the attempt.</summary>
    private sealed class StuckHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource<HttpResponseMessage> _never = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public ConcurrentQueue<string> Bodies { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Bodies.Enqueue(await request.Content!.ReadAsStringAsync().ConfigureAwait(false));
            return await _never.Task.ConfigureAwait(false);
        }

        public void Release() => _never.TrySetResult(FakeServer.Json(HttpStatusCode.ServiceUnavailable, "{}"));
    }

    [Fact]
    public async Task An_event_refused_before_sending_was_never_on_the_wire()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var server = new FakeServer();
        await using (var client = Client(Options(drops, o => o.BeforeSend = e => e.Action == "broken" ? throw new InvalidOperationException("fictional hook failure") : e), server))
        {
            client.Track(new AuditEvent("huge") { Description = new string('d', 300_000) });
            client.Track(new AuditEvent("broken"));
            Assert.True(await client.FlushAsync());
        }

        Assert.Equal([(DropReason.TooLarge, false), (DropReason.Invalid, false)], drops.Select(d => (d.Reason, d.MayBeStored)).OrderBy(d => d.Reason));
        Assert.Empty(server.Requests);
    }

    [Fact]
    public async Task A_rejection_is_not_stored_even_after_an_earlier_answer_was_lost()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var server = new FakeServer().Then(Lost).Then(request => FakeServer.Accept(request, (0, "invalid_event")));
        await using (var client = Client(Options(drops), server))
        {
            client.Track(new AuditEvent("x"));
            await client.FlushAsync();
        }

        var drop = Assert.Single(drops);
        Assert.Equal(DropReason.Rejected, drop.Reason);
        Assert.False(drop.MayBeStored);
        Assert.Equal(2, server.Requests.Count);
    }

    [Fact]
    public async Task A_permanent_error_on_the_first_answer_means_not_stored()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var server = new FakeServer().ThenStatus(HttpStatusCode.Unauthorized, "{\"error\":{\"code\":\"invalid_api_key\"}}");
        await using (var client = Client(Options(drops), server))
        {
            client.Track(new AuditEvent("x"));
            await client.FlushAsync();
        }

        var drop = Assert.Single(drops);
        Assert.Equal(DropReason.HttpError, drop.Reason);
        Assert.False(drop.MayBeStored);
    }

    [Fact]
    public async Task A_permanent_error_after_a_lost_answer_may_be_stored()
    {
        // The first request may have been stored before its answer was lost; the 401 that follows cannot undo that.
        var drops = new ConcurrentQueue<DroppedEvent>();
        var server = new FakeServer().Then(Lost).ThenStatus(HttpStatusCode.Unauthorized, "{\"error\":{\"code\":\"invalid_api_key\"}}");
        await using (var client = Client(Options(drops), server))
        {
            client.Track(new AuditEvent("x"));
            await client.FlushAsync();
        }

        var drop = Assert.Single(drops);
        Assert.Equal(DropReason.HttpError, drop.Reason);
        Assert.True(drop.MayBeStored);
    }

    [Fact]
    public async Task An_unacknowledged_event_may_be_stored()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var server = new FakeServer { Fallback = _ => Task.FromResult(FakeServer.Json(HttpStatusCode.Accepted, "{}")) };
        await using (var client = Client(Options(drops, o => o.MaxRetries = 1), server))
        {
            client.Track(new AuditEvent("x"));
            await client.FlushAsync();
        }

        var drop = Assert.Single(drops);
        Assert.Equal(DropReason.Unacknowledged, drop.Reason);
        Assert.True(drop.MayBeStored);
    }

    [Fact]
    public async Task An_event_in_flight_at_shutdown_may_be_stored()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var received = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var server = new FakeServer().ThenAsync(async request =>
        {
            received.TrySetResult(true);
            await release.Task.ConfigureAwait(false);
            return FakeServer.Accept(request);
        });
        var client = Client(Options(drops, o => o.ShutdownTimeout = TimeSpan.FromMilliseconds(200)), server);
        try
        {
            client.Track(new AuditEvent("x"));
            _ = client.FlushAsync();
            await WithinAsync(received.Task, "the request");
            await client.DisposeAsync();
        }
        finally
        {
            release.TrySetResult(true);
        }

        var drop = Assert.Single(drops);
        Assert.Equal(DropReason.Shutdown, drop.Reason);
        Assert.True(drop.MayBeStored);
    }

    [Fact]
    public async Task At_shutdown_the_event_in_flight_may_be_stored_and_the_one_behind_it_was_never_sent()
    {
        // The first event is held in flight; the second is queued behind it and never reaches the wire.
        var drops = new ConcurrentQueue<DroppedEvent>();
        var received = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var server = new FakeServer().ThenAsync(async request =>
        {
            received.TrySetResult(true);
            await release.Task.ConfigureAwait(false);
            return FakeServer.Accept(request);
        });
        var client = Client(Options(drops, o => o.ShutdownTimeout = TimeSpan.FromMilliseconds(200)), server);
        try
        {
            client.Track(new AuditEvent("in-flight") { Id = "evt_in_flight" });
            _ = client.FlushAsync();
            await WithinAsync(received.Task, "the request");
            client.Track(new AuditEvent("queued") { Id = "evt_queued" });
            await client.DisposeAsync();
        }
        finally
        {
            release.TrySetResult(true);
        }

        Assert.Equal(
            [("evt_in_flight", DropReason.Shutdown, true), ("evt_queued", DropReason.Shutdown, false)],
            drops.Select(d => (d.Id, d.Reason, d.MayBeStored)).OrderBy(d => d.Id, StringComparer.Ordinal));
        Assert.Equal(["evt_in_flight"], server.Requests.SelectMany(r => r.Ids));
    }

    [Fact]
    public async Task An_event_every_answer_refused_was_not_stored()
    {
        // 429 on every request: after its retries the batch goes back to the queue, the answers having said it was not
        // stored. A newer event then evicts it.
        var drops = new ConcurrentQueue<DroppedEvent>();
        var server = new FakeServer { Fallback = _ => Task.FromResult(FakeServer.Json((HttpStatusCode)429, "{\"error\":{\"code\":\"rate_limited\"}}")) };
        await using var client = Client(Options(drops, o =>
        {
            o.MaxRetries = 0;
            o.MaxQueueSize = 1;
            o.QueueFullBehavior = QueueFullBehavior.DropOldest;
            o.ShutdownTimeout = TimeSpan.Zero;
        }), server);
        client.Track(new AuditEvent("refused") { Id = "evt_refused" });
        await client.FlushAsync();
        client.Track(new AuditEvent("newer") { Id = "evt_newer" });

        // A flush returns after the callbacks for what it settled have run.
        await client.FlushAsync();
        var evicted = Assert.Single(drops, d => d.Reason == DropReason.QueueFull);
        Assert.Equal("evt_refused", evicted.Id);
        Assert.NotEmpty(server.Requests);
        Assert.False(evicted.MayBeStored);
    }

    [Fact]
    public async Task A_batch_that_failed_with_a_lost_answer_and_was_then_evicted_may_be_stored()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var server = new FakeServer { Fallback = _ => Task.FromException<HttpResponseMessage>(new HttpRequestException("fictional connection reset")) };
        await using var client = Client(Options(drops, o =>
        {
            o.MaxRetries = 0;
            o.MaxQueueSize = 1;
            o.QueueFullBehavior = QueueFullBehavior.DropOldest;
            o.ShutdownTimeout = TimeSpan.Zero;
        }), server);
        client.Track(new AuditEvent("sent") { Id = "evt_sent" });
        await client.FlushAsync();

        // The failed batch is back in the queue; a new event evicts it.
        client.Track(new AuditEvent("newer") { Id = "evt_newer" });
        await client.FlushAsync();
        var evicted = Assert.Single(drops, d => d.Reason == DropReason.QueueFull);
        Assert.Equal("evt_sent", evicted.Id);
        Assert.True(evicted.MayBeStored);
    }

    [Fact]
    public async Task An_event_evicted_before_it_was_ever_sent_was_not_stored()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var server = new FakeServer();
        await using (var client = Client(Options(drops, o =>
        {
            o.MaxQueueSize = 1;
            o.QueueFullBehavior = QueueFullBehavior.DropOldest;
        }), server))
        {
            client.Track(new AuditEvent("older") { Id = "evt_older" });
            client.Track(new AuditEvent("newer") { Id = "evt_newer" });
            Assert.True(await client.FlushAsync());
        }

        var evicted = Assert.Single(drops);
        Assert.Equal((DropReason.QueueFull, "evt_older", false), (evicted.Reason, evicted.Id, evicted.MayBeStored));
    }

    [Fact]
    public async Task An_event_refused_by_DropNewest_was_never_sent()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using (var client = Client(Options(drops, o =>
        {
            o.MaxQueueSize = 1;
            o.QueueFullBehavior = QueueFullBehavior.DropNewest;
        }), new FakeServer()))
        {
            client.Track(new AuditEvent("kept") { Id = "evt_kept" });
            client.Track(new AuditEvent("refused") { Id = "evt_refused" });
            Assert.True(await client.FlushAsync());
        }

        Assert.Equal([("evt_refused", DropReason.QueueFull, false)], drops.Select(d => (d.Id, d.Reason, d.MayBeStored)));
    }

    [Theory]
    [InlineData(QueueFullBehavior.DropOldest, "evt_sent", true)]
    [InlineData(QueueFullBehavior.DropNewest, "evt_queued", false)]
    public async Task A_failed_batch_put_back_into_a_full_queue_evicts_the_right_event_with_the_right_value(QueueFullBehavior behavior, string evictedId, bool mayBeStored)
    {
        // The first request is held, then loses its answer; meanwhile a second event fills the queue. Putting the failed
        // batch back overflows it: DropOldest evicts the sent event (it may be stored), DropNewest the never-sent one.
        var drops = new ConcurrentQueue<DroppedEvent>();
        var received = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var server = new FakeServer().ThenAsync(async request =>
        {
            received.TrySetResult(true);
            await release.Task.ConfigureAwait(false);
            throw new HttpRequestException("fictional connection reset");
        });
        server.Fallback = _ => Task.FromException<HttpResponseMessage>(new HttpRequestException("fictional connection reset"));
        await using var client = Client(Options(drops, o =>
        {
            o.MaxRetries = 0;
            o.MaxQueueSize = 1;
            o.QueueFullBehavior = behavior;
            o.ShutdownTimeout = TimeSpan.Zero;
        }), server);
        try
        {
            client.Track(new AuditEvent("sent") { Id = "evt_sent" });
            var first = client.FlushAsync();
            await WithinAsync(received.Task, "the first request");
            client.Track(new AuditEvent("queued") { Id = "evt_queued" });
            release.TrySetResult(true);
            await WithinAsync(first, "the first flush");
            await client.FlushAsync();
        }
        finally
        {
            release.TrySetResult(true);
        }

        var evicted = Assert.Single(drops, d => d.Reason == DropReason.QueueFull);
        Assert.Equal((evictedId, mayBeStored), (evicted.Id, evicted.MayBeStored));
    }

    [Fact]
    public async Task An_event_tracked_after_shutdown_was_never_sent_and_has_no_payload()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var client = Client(Options(drops), new FakeServer());
        await client.DisposeAsync();
        client.Track(new AuditEvent("late") { Id = "evt_late" });
        await Task.Delay(200);
        var drop = Assert.Single(drops);
        Assert.Equal((DropReason.Shutdown, false), (drop.Reason, drop.MayBeStored));
        Assert.True(drop.Json.IsEmpty);
    }

    [Theory]
    [InlineData(500)]
    [InlineData(502)]
    [InlineData(307)]
    public async Task A_5xx_or_a_redirect_leaves_the_outcome_unknown_even_after_a_later_401(int first)
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var server = new FakeServer().ThenStatus((HttpStatusCode)first).ThenStatus(HttpStatusCode.Unauthorized, "{\"error\":{\"code\":\"invalid_api_key\"}}");
        await using (var client = Client(Options(drops), server))
        {
            client.Track(new AuditEvent("x"));
            await client.FlushAsync();
        }

        var drop = Assert.Single(drops);
        Assert.Equal(DropReason.HttpError, drop.Reason);
        Assert.Equal(first == 307 ? 1 : 2, server.Requests.Count);
        Assert.True(drop.MayBeStored);
    }

    [Fact]
    public async Task An_event_a_503_left_unresolved_may_be_stored_even_after_a_later_401()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var server = new FakeServer()
            .Then(request => FakeServer.Json(HttpStatusCode.ServiceUnavailable, "{\"error\":{\"code\":\"ingest_pending\",\"details\":{\"accepted\":1,\"ids\":[\"" + request.Ids[0] + "\"],\"rejected\":[],\"indices\":[1],\"eventIds\":[\"" + request.Ids[1] + "\"],\"warnings\":[]}}}"))
            .ThenStatus(HttpStatusCode.Unauthorized, "{\"error\":{\"code\":\"invalid_api_key\"}}");
        await using (var client = Client(Options(drops), server))
        {
            client.Track(new AuditEvent("stored") { Id = "evt_stored" });
            client.Track(new AuditEvent("unresolved") { Id = "evt_unresolved" });
            await client.FlushAsync();
            Assert.Equal(1, client.Stats.Delivered);
        }

        Assert.Equal([("evt_unresolved", DropReason.HttpError, true)], drops.Select(d => (d.Id, d.Reason, d.MayBeStored)));
    }

    [Fact]
    public async Task A_request_timeout_leaves_the_outcome_unknown_even_after_a_later_401()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var server = new FakeServer()
            .ThenAsync(async request =>
            {
                await release.Task.ConfigureAwait(false);
                return FakeServer.Accept(request);
            })
            .ThenStatus(HttpStatusCode.Unauthorized, "{\"error\":{\"code\":\"invalid_api_key\"}}");
        try
        {
            await using var client = Client(Options(drops, o => o.RequestTimeout = TimeSpan.FromMilliseconds(100)), server);
            client.Track(new AuditEvent("x"));
            await client.FlushAsync();
        }
        finally
        {
            release.TrySetResult(true);
        }

        var drop = Assert.Single(drops);
        Assert.Equal((DropReason.HttpError, true), (drop.Reason, drop.MayBeStored));
    }

    [Fact]
    public async Task A_401_whose_body_cannot_be_read_still_says_not_stored()
    {
        // The body is over the response limit, so reading it fails; the status from the headers still counts.
        var drops = new ConcurrentQueue<DroppedEvent>();
        var huge = new string('x', Internal.BatchSender.MaxResponseBytes + 1024);
        var server = new FakeServer { Fallback = _ => Task.FromResult(FakeServer.Json(HttpStatusCode.Unauthorized, "{\"error\":\"" + huge + "\"}")) };
        await using (var client = Client(Options(drops, o =>
        {
            o.MaxRetries = 0;
            o.MaxQueueSize = 1;
            o.QueueFullBehavior = QueueFullBehavior.DropOldest;
        }), server))
        {
            client.Track(new AuditEvent("x") { Id = "evt_first" });
            await client.FlushAsync();
            client.Track(new AuditEvent("y") { Id = "evt_second" });
            await client.FlushAsync();
        }

        var first = Assert.Single(drops, d => d.Id == "evt_first");
        Assert.False(first.MayBeStored);
    }

    [Fact]
    public async Task Events_held_back_by_stuck_requests_are_never_dispatched()
    {
        // Four requests that never return fill the limit of abandoned attempts. A later event is never put on the wire,
        // so at shutdown it reports false while the event that was sent reports true.
        var drops = new ConcurrentQueue<DroppedEvent>();
        var stuck = new StuckHandler();
        var client = Client(Options(drops, o =>
        {
            o.RequestTimeout = TimeSpan.FromMilliseconds(20);
            o.MaxRetries = Internal.BatchSender.MaxAbandonedAttempts - 1;
            o.ShutdownTimeout = TimeSpan.Zero;
        }), stuck);
        try
        {
            client.Track(new AuditEvent("sent") { Id = "evt_sent" });
            await client.FlushAsync();
            Assert.Equal(Internal.BatchSender.MaxAbandonedAttempts, stuck.Bodies.Count);
            client.Track(new AuditEvent("held") { Id = "evt_held" });
            await client.FlushAsync();
            await client.DisposeAsync();
        }
        finally
        {
            stuck.Release();
        }

        Assert.DoesNotContain(stuck.Bodies, b => b.Contains("evt_held"));
        Assert.Equal(
            [("evt_held", false), ("evt_sent", true)],
            drops.Where(d => d.Reason == DropReason.Shutdown).Select(d => (d.Id!, d.MayBeStored)).OrderBy(d => d.Item1, StringComparer.Ordinal));
    }

    [Fact]
    public void Dispatch_and_shutdown_take_an_event_in_one_decision()
    {
        var abandonedFirst = new Internal.QueuedEvent([], "evt_a", "x", 1);
        Assert.True(abandonedFirst.TryAbandon());
        Assert.False(abandonedFirst.TryStartDispatch());
        Assert.False(abandonedFirst.MayBeStoredWhenAbandoned);

        var dispatchedFirst = new Internal.QueuedEvent([], "evt_b", "x", 2);
        Assert.True(dispatchedFirst.TryStartDispatch());
        Assert.True(dispatchedFirst.TryAbandon());

        // A later answer cannot change what shutdown already reported.
        dispatchedFirst.OnNotStored();
        Assert.True(dispatchedFirst.MayBeStoredWhenAbandoned);
    }

    [Theory]
    [InlineData("stored_event_unreadable", true, true)]
    [InlineData("unverified_after_parse_failure", true, true)]
    [InlineData("stored_event_unreadable", false, false)]
    [InlineData("duplicate_id_conflict", true, false)]
    public async Task A_rejection_that_says_nothing_about_content_keeps_an_earlier_lost_answer(string code, bool loseFirst, bool expected)
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var server = new FakeServer();
        if (loseFirst)
        {
            server.Then(Lost);
        }

        server.Then(request => FakeServer.Accept(request, (0, code)));
        await using (var client = Client(Options(drops), server))
        {
            client.Track(new AuditEvent("x"));
            await client.FlushAsync();
        }

        var drop = Assert.Single(drops);
        Assert.Equal((DropReason.Rejected, code, expected), (drop.Reason, drop.Code, drop.MayBeStored));
    }
}
