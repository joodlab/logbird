using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>Host code that misbehaves (listeners, callbacks, handlers) and hostile inputs.</summary>
public class ResilienceTests
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

    /// <summary>Blocks inside SendAsync before returning any task, then never answers.</summary>
    private sealed class BlockingHandler(ManualResetEventSlim release) : HttpMessageHandler
    {
        public int Calls;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Calls);
            release.Wait();
            return new TaskCompletionSource<HttpResponseMessage>().Task;
        }
    }

    [Fact]
    public async Task A_listener_that_tracks_on_every_measurement_cannot_recurse()
    {
        LogbirdClient? client = null;
        var calls = 0;
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
        listener.SetMeasurementEventCallback<long>((_, _, _, _) =>
        {
            if (Interlocked.Increment(ref calls) < 10_000)
            {
                client?.Track(new AuditEvent("from.listener"));
            }
        });
        listener.Start();
        client = Client(Options(), new FakeServer());
        await using (client)
        {
            client.Track(new AuditEvent("measured"));
            Assert.True(await client.FlushAsync());
        }

        Assert.True(calls < 10_000, $"{calls} measurements");
    }

    [Fact]
    public void Instrument_creation_failures_disable_the_instrument_instead_of_failing()
    {
        var created = typeof(Internal.LogbirdMetrics).GetMethod("Create", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!
            .MakeGenericMethod(typeof(Counter<long>));
        Func<Counter<long>?> broken = () => throw new InvalidOperationException("fictional listener failure at publication");
        Assert.Null(created.Invoke(null, [broken]));
    }

    [Fact]
    public async Task A_blocking_OnDrop_hook_does_not_block_Track_or_shutdown()
    {
        using var block = new ManualResetEventSlim();
        var client = Client(Options(o =>
        {
            o.MaxQueueSize = 1;
            o.OnDrop = _ => block.Wait();
            o.ShutdownTimeout = TimeSpan.FromMilliseconds(100);
        }), new FakeServer());
        try
        {
            var watch = Stopwatch.StartNew();
            for (var i = 0; i < 50; i++)
            {
                client.Track(new AuditEvent("overflow"));
            }

            // OnDrop blocks forever, so a Track that waited on it would never return: any finite limit proves the point.
            Assert.True(watch.Elapsed < TimeSpan.FromSeconds(30), watch.Elapsed.ToString());
            watch.Restart();
            await client.DisposeAsync();

            // Documented bound: ShutdownTimeout + 2 s + 5 s for pending callbacks.
            Assert.True(watch.Elapsed < TimeSpan.FromSeconds(15), watch.Elapsed.ToString());
            Assert.Equal(49, client.Stats.Dropped);
        }
        finally
        {
            block.Set();
        }
    }

    [Fact]
    public async Task A_handler_that_blocks_before_returning_cannot_defeat_RequestTimeout()
    {
        using var release = new ManualResetEventSlim();
        var handler = new BlockingHandler(release);
        var client = Client(Options(o =>
        {
            o.RequestTimeout = TimeSpan.FromMilliseconds(100);
            o.MaxRetries = 6;
            o.ShutdownTimeout = TimeSpan.Zero;
        }), handler);
        try
        {
            client.Track(new AuditEvent("blocked"));
            var watch = Stopwatch.StartNew();
            Assert.False(await client.FlushAsync(TimeSpan.FromSeconds(30)));

            // The send gave up on its own; the alternative is waiting out the flush's 30-second limit.
            Assert.True(watch.Elapsed < TimeSpan.FromSeconds(20), watch.Elapsed.ToString());

            // Stuck requests are capped instead of piling up across retries.
            Assert.True(handler.Calls <= Internal.BatchSender.MaxAbandonedAttempts, $"{handler.Calls} requests");
            Assert.Equal(1, client.Stats.QueueLength);
        }
        finally
        {
            release.Set();
            await client.DisposeAsync();
        }
    }

    [Fact]
    public async Task A_rejection_whose_reason_cannot_be_decoded_still_settles_like_typescript()
    {
        var b = '\\';
        var server = new FakeServer().Then(request =>
            FakeServer.Json(HttpStatusCode.Accepted, "{\"accepted\":1,\"ids\":[\"" + request.Ids[1] + "\"],\"rejected\":[{\"index\":0,\"reason\":\"bad " + b + "ud800 reason\",\"code\":\"invalid_event\"}]}"));
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o => o.OnDrop = drops.Enqueue), server);
        client.Track(new AuditEvent("rejected"));
        client.Track(new AuditEvent("sibling"));
        Assert.True(await client.FlushAsync());
        Assert.Single(server.Requests);
        Assert.Equal(new LogbirdStats(2, 1, 1, 0, 0, 0, 0), client.Stats);
        Assert.Contains("ud800", Assert.Single(drops).Detail);
    }

    [Fact]
    public async Task Deeply_nested_json_is_dropped_as_invalid_instead_of_overflowing_the_stack()
    {
        // Built bottom-up and never walked here: System.Text.Json itself recurses up the parent chain when a node this
        // deep is touched, which is exactly why Logbird must stop at its depth limit before looking further.
        static JsonNode Chain(int depth)
        {
            JsonNode node = new JsonObject { ["leaf"] = true };
            for (var i = 0; i < depth; i++)
            {
                node = new JsonObject { ["n"] = node };
            }

            return node;
        }

        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o => o.OnDrop = drops.Enqueue), new FakeServer());
        client.Track(new AuditEvent("deep") { Metadata = { ["tree"] = Chain(100_000) } });
        client.Track(new AuditEvent("deep.change").Change("tree", null, Chain(100_000)));
        Assert.True(await client.FlushAsync());
        Assert.Equal(2, drops.Count(d => d.Reason == DropReason.Invalid));
    }

    [Fact]
    public void Numbers_are_laid_out_like_javascript_with_every_digit()
    {
        Assert.Equal("1", Internal.JsJson.FormatNumber("1.00"));
        Assert.Equal("0.1", Internal.JsJson.FormatNumber("0.10"));
        Assert.Equal("1e+21", Internal.JsJson.FormatNumber("1E+21"));
        Assert.Equal("100000000000000000000", Internal.JsJson.FormatNumber("1E+20"));
        Assert.Equal("1e-7", Internal.JsJson.FormatNumber("1E-07"));
        Assert.Equal("0.000001", Internal.JsJson.FormatNumber("1E-06"));
        Assert.Equal("0", Internal.JsJson.FormatNumber("-0"));
        Assert.Equal("-1.5", Internal.JsJson.FormatNumber("-1.5"));
        Assert.Equal("1234567890123456789", Internal.JsJson.FormatNumber("1234567890123456789"));
        Assert.Equal("12345678901234.567890123456", Internal.JsJson.FormatNumber("12345678901234.567890123456"));
        Assert.Equal("1.23456789012345678901234e+23", Internal.JsJson.FormatNumber("123456789012345678901234"));
    }

    [Fact]
    public void Trails_require_a_filter_and_reject_wildcard_values()
    {
        Assert.Throws<ArgumentException>(() => EventSearch.ForTrail());
        Assert.Throws<ArgumentException>(() => EventSearch.ForTrail(query: "  "));
        Assert.Throws<ArgumentException>(() => EventSearch.ForTrail(tenantId: "acct_*"));
        Assert.Throws<ArgumentException>(() => EventSearch.ForTrail(targetId: "*"));
        Assert.Equal("(action:invoice.*)", EventSearch.ForTrail(query: "action:invoice.*").Query);
    }

    [Fact]
    public async Task A_cursor_cycle_is_detected_before_a_page_repeats()
    {
        var server = new FakeServer()
            .ThenStatus(HttpStatusCode.OK, """{"data":[],"nextCursor":"a","total":1,"tookMs":1}""")
            .ThenStatus(HttpStatusCode.OK, """{"data":[],"nextCursor":"b","total":1,"tookMs":1}""")
            .ThenStatus(HttpStatusCode.OK, """{"data":[],"nextCursor":"a","total":1,"tookMs":1}""");
        using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "k" }, new HttpClient(server));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(async () =>
        {
            await foreach (var _ in reader.SearchAllAsync())
            {
            }
        });
        Assert.Equal("pagination_stalled", error.Code);
        Assert.Equal(3, server.Requests.Count);
        await Assert.ThrowsAsync<ArgumentException>(() => reader.GetAsync(".."));
        Assert.Throws<ArgumentException>(() => new LogbirdReadClient(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "k", Timeout = TimeSpan.FromDays(30) }));
    }

    [Fact]
    public async Task A_timed_out_synchronous_flush_is_forgotten()
    {
        using var release = new ManualResetEventSlim();
        var client = Client(Options(o => o.ShutdownTimeout = TimeSpan.Zero), new BlockingHandler(release));
        try
        {
            client.Track(new AuditEvent("pending"));
            Assert.False(client.Flush(TimeSpan.FromMilliseconds(50)));
            var waiters = typeof(Internal.EventQueue).GetField("_waiters", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;
            var queue = typeof(LogbirdClient).GetField("_queue", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(client)!;

            // The flush may start late on a busy pool; once it has, its already-cancelled wait is removed at once.
            var watch = Stopwatch.StartNew();
            while (((System.Collections.ICollection)waiters.GetValue(queue)!).Count > 0 && watch.Elapsed < TimeSpan.FromSeconds(30))
            {
                await Task.Delay(20);
            }

            Assert.Empty((System.Collections.ICollection)waiters.GetValue(queue)!);
        }
        finally
        {
            release.Set();
            await client.DisposeAsync();
        }
    }

    [Fact]
    public async Task The_owned_http_handler_never_follows_a_redirect()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var requests = 0;
        using var stop = new CancellationTokenSource();
        var server = Task.Run(async () =>
        {
            while (!stop.IsCancellationRequested)
            {
                using var socket = await listener.AcceptTcpClientAsync();
                Interlocked.Increment(ref requests);
                var stream = socket.GetStream();
                var buffer = new byte[65536];
                await stream.ReadAsync(buffer, 0, buffer.Length);
                var response = Encoding.ASCII.GetBytes(
                    $"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{port}/elsewhere/v1/events\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(response, 0, response.Length);
            }
        });
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using (var client = new LogbirdClient(new LogbirdOptions
        {
            Endpoint = new Uri($"http://127.0.0.1:{port}"),
            IngestKey = "lb_ingest_fictional",
            OnDrop = drops.Enqueue,
        }))
        {
            client.Track(new AuditEvent("redirected"));
            Assert.True(await client.FlushAsync(TimeSpan.FromSeconds(20)));
        }

        stop.Cancel();
        listener.Stop();
        Assert.Equal(1, requests);
        Assert.Equal(DropReason.HttpError, Assert.Single(drops).Reason);
    }
}
