using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>Step-4 review, delivery and accounting: A01 (first skipped callback reported once), A02, A03, A05.</summary>
public class Step4DeliveryTests
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

    /// <summary>A small body that declares more than the ingest client will read.</summary>
    private static HttpResponseMessage Unreadable(HttpStatusCode status)
    {
        var content = new StringContent("{}", Encoding.UTF8, "application/json");
        content.Headers.ContentLength = 100_000_000;
        return new HttpResponseMessage(status) { Content = content };
    }

    // ---------------------------------------------------------------- A03: a permanent status stays permanent

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.MovedPermanently)]
    public async Task A_permanent_answer_whose_body_cannot_be_read_is_dropped_at_once_as_an_HTTP_error(HttpStatusCode status)
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var server = new FakeServer { Fallback = _ => Task.FromResult(Unreadable(status)) };
        await using var client = Client(Options(o =>
        {
            o.MaxRetries = 5;
            o.OnDrop = drops.Enqueue;
        }), server);
        client.Track(new AuditEvent("x"));
        Assert.True(await client.FlushAsync());

        Assert.Single(server.Requests);
        Assert.Equal(DropReason.HttpError, Assert.Single(drops).Reason);
        Assert.Equal(0, client.Stats.QueueLength);
    }

    [Theory]
    [InlineData((HttpStatusCode)429)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    [InlineData(HttpStatusCode.Accepted)]
    public async Task Any_other_answer_whose_body_cannot_be_read_is_retried_not_dropped(HttpStatusCode status)
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var server = new FakeServer().Then(_ => Unreadable(status));
        await using var client = Client(Options(o =>
        {
            o.MaxRetries = 3;
            o.OnDrop = drops.Enqueue;
        }), server);
        client.Track(new AuditEvent("x"));
        Assert.True(await client.FlushAsync());

        Assert.Equal(2, server.Requests.Count);
        Assert.Empty(drops);
        Assert.Equal(1, client.Stats.Delivered);
    }

    // ---------------------------------------------------------------- A02: the report is posted inside the settlement

    [Fact]
    public async Task A_rejection_report_is_posted_before_the_settlement_is_released()
    {
        var order = new List<string>();
        var server = new FakeServer().Then(request => FakeServer.Accept(request, (0, "invalid_event")));
        var sender = new Internal.BatchSender(
            new HttpClient(server),
            Endpoint,
            "lb_ingest_fictional",
            0,
            TimeSpan.FromSeconds(10),
            drop: (_, _, _, _) => () => order.Add("report posted"),
            warn: (_, _) => { },
            progress: () => { },
            report: _ => { },
            countDrop: _ => order.Add("counted"),
            settle: (item, count) =>
            {
                if (!item.TrySettle())
                {
                    return false;
                }

                order.Add("settled");
                count();

                // What a flush waiting on this settlement can observe once the queue lock is released.
                order.Add("released");
                return true;
            });
        var json = Encoding.UTF8.GetBytes("{\"id\":\"evt_1\",\"action\":\"x\",\"occurredAt\":\"2026-11-23T00:00:00.000Z\"}");
        await sender.SendAsync([new Internal.QueuedEvent(json, "evt_1", "x", 1)], CancellationToken.None);

        Assert.Equal(["settled", "counted", "report posted", "released"], order);
    }

    // ---------------------------------------------------------------- A01: the first skipped callback is reported once

    [Fact]
    public async Task The_first_skipped_callback_is_reported_once_through_OnError_even_while_the_queue_is_full()
    {
        var gate = new ManualResetEventSlim();
        var notices = new ConcurrentQueue<Exception>();
        var client = Client(Options(o =>
        {
            o.MaxQueueSize = 1_000;
            o.OnDrop = _ => gate.Wait();
            o.OnError = e =>
            {
                if (e.Message.Contains("logbird.notifications.lost", StringComparison.Ordinal))
                {
                    notices.Enqueue(e);
                }
            };
        }), new FakeServer());
        await client.DisposeAsync();
        try
        {
            // Each event tracked after shutdown is a drop with its own notification; the first OnDrop blocks, so the
            // notification queue (1,000) fills and later ones are skipped, many times over.
            for (var i = 0; i < 3_000; i++)
            {
                client.Track(new AuditEvent("after shutdown"));
            }

            await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
            {
                while (notices.IsEmpty)
                {
                    await Task.Delay(20);
                }
            });
            await Task.Delay(300);
            Assert.Single(notices);
            Assert.True(client.NotificationsLost > 1);
        }
        finally
        {
            gate.Set();
        }
    }

    // ---------------------------------------------------------------- A05: size and depth decided on what is sent

    [Fact]
    public async Task A_secret_that_redaction_shrinks_is_sent_not_dropped_as_too_large()
    {
        var server = new FakeServer();
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o => o.OnDrop = drops.Enqueue), server);
        client.Track(new AuditEvent("x") { Metadata = { ["token"] = new string('s', 270_000) } });
        Assert.True(await client.FlushAsync());

        Assert.Empty(drops);
        var sent = Assert.Single(server.Requests.SelectMany(r => r.Events));
        Assert.Equal("[redacted]", sent.GetProperty("metadata").GetProperty("token").GetString());
    }

    [Fact]
    public async Task An_event_BeforeSend_shrinks_is_sent_not_dropped_as_too_large()
    {
        var server = new FakeServer();
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o =>
        {
            o.OnDrop = drops.Enqueue;
            o.BeforeSend = e =>
            {
                e.Description = e.Description!.Substring(0, 100);
                return e;
            };
        }), server);
        client.Track(new AuditEvent("x") { Description = new string('d', 300_000) });
        Assert.True(await client.FlushAsync());

        Assert.Empty(drops);
        Assert.Equal(100, Assert.Single(server.Requests.SelectMany(r => r.Events)).GetProperty("description").GetString()!.Length);
    }

    [Fact]
    public async Task Data_over_the_memory_guard_is_refused_before_it_is_copied()
    {
        var copies = 0;
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o =>
        {
            o.OnDrop = drops.Enqueue;
            o.BeforeSend = e =>
            {
                Interlocked.Increment(ref copies);
                return e;
            };
        }), new FakeServer());
        client.Track(new AuditEvent("x") { Metadata = { ["token"] = new string('s', LogbirdClient.MaxDataBytes + 1) } });
        Assert.True(await client.FlushAsync());

        Assert.Equal(0, copies);
        var drop = Assert.Single(drops);
        Assert.Equal(DropReason.TooLarge, drop.Reason);
        Assert.True(drop.Json.IsEmpty);
        Assert.False(drop.MayBeStored);
    }

#if NET
    [Fact]
    public async Task A_tree_over_the_memory_guard_is_measured_without_being_copied()
    {
        // 600,000 numbers is over the guard. Copying them (to redact or to send) would allocate tens of megabytes of nodes;
        // refusing them must allocate next to nothing on the tracking thread.
        var numbers = new JsonArray();
        for (var i = 0; i < 600_000; i++)
        {
            numbers.Add((JsonNode)i);
        }

        var auditEvent = new AuditEvent("numbers") { Metadata = { ["n"] = numbers } };
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o => o.OnDrop = drops.Enqueue), new FakeServer());
        client.Track(new AuditEvent("warm up"));

        var before = GC.GetAllocatedBytesForCurrentThread();
        client.Track(auditEvent);
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.True(allocated < 1024 * 1024, allocated.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Assert.True(await client.FlushAsync());
        var drop = Assert.Single(drops, d => d.Action == "numbers");
        Assert.Equal(DropReason.TooLarge, drop.Reason);
        Assert.False(drop.MayBeStored);
    }
#endif

    private const string StoredEventJson = """
        {"id":"evt_1","projectId":"prj_1","timestamp":"2026-11-22T08:00:00.123Z","receivedAt":"2026-11-22T08:00:01.000Z",
         "environment":"staging","action":"limits.deep","category":"limits","outcome":"success","severity":"info",
         "description":"","actor":null,"impersonator":null,"executor":null,"tenant":null,"source":null,
         "targets":[],"changes":[],
         "context":{"operationId":"","parentEventId":"","requestId":"","traceId":"","ip":"","userAgent":""},
         "attributes":{},"conformance":10,"schemaVersion":"","sdk":"dotnet/0.2.1"}
        """;

    [Fact]
    public async Task The_read_client_reads_back_a_payload_nested_to_the_send_limit()
    {
        // What the client may send (metadata 1,000 levels deep), its read client must read back: the detail envelope adds
        // a few levels on top, far beyond System.Text.Json's default of 64.
        var payload = "{\"metadata\":{\"tree\":" + Chain(997).ToJsonString(new JsonSerializerOptions { MaxDepth = 2_048 }) + "}}";
        var detail = "{\"event\":" + StoredEventJson + ",\"payload\":" + payload + ",\"parents\":[],\"childCount\":0,\"operationSize\":1}";
        var server = new FakeServer { Fallback = _ => Task.FromResult(FakeServer.Json(HttpStatusCode.OK, detail)) };
        using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "lb_read_fictional" }, new HttpClient(server));
        var read = await reader.GetEventAsync("evt_1");

        var node = read!.Payload.GetProperty("metadata").GetProperty("tree");
        var levels = 0;
        while (node.TryGetProperty("n", out var next))
        {
            node = next;
            levels++;
        }

        Assert.Equal(997, levels);
    }

    private static JsonNode Chain(int depth)
    {
        JsonNode node = new JsonObject { ["leaf"] = 1 };
        for (var i = 0; i < depth; i++)
        {
            node = new JsonObject { ["n"] = node };
        }

        return node;
    }

    [Theory]
    [InlineData(49, false)]
    [InlineData(49, true)]
    [InlineData(997, false)]
    [InlineData(997, true)]
    public async Task Deep_metadata_up_to_the_limit_is_sent_even_from_a_small_stack(int depth, bool withHook)
    {
        // 997 levels under "tree" puts the leaf at level 1,000 of metadata, the limit. The event is tracked on a thread with a
        // 256 KB stack, a quarter of a thread-pool thread's. The SDK's own steps (the BeforeSend copy, the send copy,
        // redaction, writing) are iterative; System.Text.Json's DeepClone, which they replace, overflowed such a stack
        // after about 830 levels.
        var server = new FakeServer();
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o =>
        {
            o.OnDrop = drops.Enqueue;
            if (withHook)
            {
                o.BeforeSend = e => e;
            }
        }), server);
        Exception? failure = null;
        var thread = new Thread(
            () =>
            {
                try
                {
                    client.Track(new AuditEvent("deep") { Metadata = { ["tree"] = Chain(depth) } });
                }
                catch (Exception e)
                {
                    failure = e;
                }
            },
            256 * 1024);
        thread.Start();
        thread.Join();
        Assert.Null(failure);
        Assert.True(await client.FlushAsync());

        Assert.Empty(drops);
        var sent = Assert.Single(server.Requests);
        var reader = new Utf8JsonReader(sent.Body, new JsonReaderOptions { MaxDepth = 65_536 });
        var deepest = 0;
        while (reader.Read())
        {
            deepest = Math.Max(deepest, reader.CurrentDepth);
        }

        Assert.True(deepest >= depth + 2, deepest.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }
}
