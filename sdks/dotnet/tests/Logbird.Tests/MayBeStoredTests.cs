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
        var server = new FakeServer().ThenAsync(async request =>
        {
            received.TrySetResult(true);
            await Task.Delay(Timeout.Infinite).ConfigureAwait(false);
            return FakeServer.Accept(request);
        });
        var client = Client(Options(drops, o => o.ShutdownTimeout = TimeSpan.FromMilliseconds(200)), server);
        client.Track(new AuditEvent("x"));
        _ = client.FlushAsync();
        await received.Task;
        await client.DisposeAsync();

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
        var server = new FakeServer().ThenAsync(async request =>
        {
            received.TrySetResult(true);
            await Task.Delay(Timeout.Infinite).ConfigureAwait(false);
            return FakeServer.Accept(request);
        });
        var client = Client(Options(drops, o => o.ShutdownTimeout = TimeSpan.FromMilliseconds(200)), server);
        client.Track(new AuditEvent("in-flight") { Id = "evt_in_flight" });
        _ = client.FlushAsync();
        await received.Task;
        client.Track(new AuditEvent("queued") { Id = "evt_queued" });
        await client.DisposeAsync();

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
}
