using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
#if NETFRAMEWORK
using Logbird.Tests.Compat;
#endif

namespace Logbird.Tests;

/// <summary>Flush and shutdown settle exactly what was queued: never early, never lost, never twice.</summary>
public class SettlementTests
{
    private static readonly Uri Endpoint = new("https://audit.example.invalid/");

    private static LogbirdOptions Options(Action<LogbirdOptions>? configure = null)
    {
        var options = new LogbirdOptions { Endpoint = Endpoint, IngestKey = "lb_ingest_fictional", FlushInterval = TimeSpan.FromHours(1) };
        configure?.Invoke(options);
        return options;
    }

    /// <summary>A handler that ignores cancellation and answers only when released, like a misbehaving custom handler.</summary>
    private sealed class StubbornHandler : HttpMessageHandler
    {
        public TaskCompletionSource<bool> Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource<bool> Received { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = await request.Content!.ReadAsByteArrayAsync(CancellationToken.None).ConfigureAwait(false);
            Received.TrySetResult(true);
            await Release.Task.ConfigureAwait(false);
            using var document = JsonDocument.Parse(body);
            var ids = document.RootElement.GetProperty("events").EnumerateArray().Select(e => e.GetProperty("id").GetString()).ToArray();
            return new HttpResponseMessage(HttpStatusCode.Accepted)
            {
                Content = new StringContent(JsonSerializer.Serialize(new { accepted = ids.Length, ids, rejected = Array.Empty<object>() }), Encoding.UTF8, "application/json"),
            };
        }
    }

    private sealed class ThrowingLogger : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            => throw new InvalidOperationException("fictional broken logging provider");
    }

    [Fact]
    public async Task Flush_stays_pending_while_the_batch_is_in_flight()
    {
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var received = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var server = new FakeServer().ThenAsync(async request =>
        {
            received.TrySetResult(true);
            await release.Task;
            return FakeServer.Accept(request);
        });
        await using var client = new LogbirdClient(Options(), new HttpClient(server));
        client.Track(new AuditEvent("held"));
        var first = client.FlushAsync();
        await received.Task;

        // The queue is empty and the only event is in flight: a new flush must wait for it.
        var second = client.FlushAsync();
        await Task.Delay(200);
        Assert.False(first.IsCompleted);
        Assert.False(second.IsCompleted);
        release.SetResult(true);
        Assert.True(await first);
        Assert.True(await second);
        Assert.Equal(1, client.Stats.Delivered);
    }

    [Fact]
    public async Task A_successful_flush_always_means_the_event_was_delivered()
    {
        var server = new FakeServer
        {
            Fallback = async request =>
            {
                await Task.Yield();
                return FakeServer.Accept(request);
            },
        };
        await using var client = new LogbirdClient(Options(), new HttpClient(server));
        for (var i = 1; i <= 300; i++)
        {
            client.Track(new AuditEvent("raced"));
            Assert.True(await client.FlushAsync());
            Assert.Equal(i, client.Stats.Delivered);
        }
    }

    [Fact]
    public async Task Shutdown_reports_an_in_flight_batch_once_and_ignores_a_late_response()
    {
        var handler = new StubbornHandler();
        var drops = new ConcurrentQueue<DroppedEvent>();
        var client = new LogbirdClient(Options(o =>
        {
            o.ShutdownTimeout = TimeSpan.FromMilliseconds(200);
            o.OnDrop = drops.Enqueue;
        }), new HttpClient(handler));
        for (var i = 0; i < 3; i++)
        {
            client.Track(new AuditEvent("in.flight"));
        }

        _ = client.FlushAsync();
        await handler.Received.Task;
        client.Track(new AuditEvent("queued.behind"));
        await client.DisposeAsync();
        Assert.Equal(4, drops.Count(d => d.Reason == DropReason.Shutdown));

        // The request finally returns after disposal: nothing is requeued, counted or reported again.
        handler.Release.SetResult(true);
        await Task.Delay(300);
        Assert.Equal(4, drops.Count);
        Assert.Equal(new LogbirdStats(4, 0, 0, 4, 0, 0, 0), client.Stats);

        // Nothing is outstanding any more: the four events were settled by being dropped and reported.
        Assert.True(await client.FlushAsync());
    }

    [Fact]
    public async Task A_throwing_logger_cannot_hold_a_failed_flush()
    {
        var server = new FakeServer { Fallback = _ => Task.FromResult(FakeServer.Json(HttpStatusCode.ServiceUnavailable, "{}")) };
        await using var client = new LogbirdClient(Options(o => o.MaxRetries = 0), new HttpClient(server), new ThrowingLogger());
        client.Track(new AuditEvent("logged"));
        var flush = client.FlushAsync();
        Assert.Same(flush, await Task.WhenAny(flush, Task.Delay(TimeSpan.FromSeconds(10))));
        Assert.False(await flush);
        Assert.Equal(1, client.Stats.QueueLength);
    }

    [Fact]
    public async Task An_unexpected_failure_after_a_503_keeps_earlier_settlement()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        string[]? ids = null;
        var server = new FakeServer()
            .Then(request =>
            {
                ids = request.Ids;
                var details = new
                {
                    accepted = 1,
                    ids = new[] { ids[0] },
                    rejected = new[] { new { index = 1, reason = "invalid_event: fictional", code = "invalid_event" } },
                    warnings = Array.Empty<object>(),
                    indices = new[] { 2, 3 },
                    eventIds = new[] { ids[2], ids[3] },
                };
                return FakeServer.Json(HttpStatusCode.ServiceUnavailable, JsonSerializer.Serialize(new { error = new { code = "ingest_pending", details } }));
            })

            // A rejection reason that cannot be decoded (a lone surrogate escape) makes the response unreadable.
            .Then(_ => FakeServer.Json(HttpStatusCode.Accepted, "{\"accepted\":0,\"ids\":[],\"rejected\":[{\"index\":0,\"reason\":\"" + '\\' + "ud800\",\"code\":\"x\"}]}"));
        await using var client = new LogbirdClient(Options(o =>
        {
            o.MaxRetries = 0;
            o.OnDrop = drops.Enqueue;
        }), new HttpClient(server));
        for (var i = 0; i < 4; i++)
        {
            client.Track(new AuditEvent("mixed"));
        }

        Assert.False(await client.FlushAsync());
        Assert.Equal(new LogbirdStats(4, 1, 1, 0, 0, 1, 2), client.Stats);
        Assert.True(await client.FlushAsync());
        var requests = server.Requests.ToArray();
        Assert.Equal(3, requests.Length);
        Assert.Equal([ids![2], ids[3]], requests[2].Ids);
        Assert.Equal(new LogbirdStats(4, 3, 1, 0, 0, 1, 0), client.Stats);
        Assert.Equal(ids[1], Assert.Single(drops).Id);
    }

    [Fact]
    public async Task A_flush_from_a_delivery_callback_returns_false_instead_of_waiting_on_itself()
    {
        LogbirdClient? client = null;
        bool? asyncResult = null;
        bool? syncResult = null;
        var server = new FakeServer().Then(request => FakeServer.Accept(request, (0, "invalid_event")));
        client = new LogbirdClient(Options(o => o.OnDrop = _ =>
        {
            asyncResult = client!.FlushAsync().GetAwaiter().GetResult();
            syncResult = client!.Flush(TimeSpan.FromSeconds(30));
        }), new HttpClient(server));
        await using (client)
        {
            client.Track(new AuditEvent("rejected"));
            Assert.True(await client.FlushAsync(TimeSpan.FromSeconds(10)));
        }

        Assert.False(asyncResult);
        Assert.False(syncResult);
    }
}
