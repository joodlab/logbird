using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>One test per item of the final fix cycle on the core SDK.</summary>
public class FinalCycleTests
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

    private static int WaiterCount(LogbirdClient client)
    {
        var waiters = typeof(Internal.EventQueue).GetField("_waiters", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;
        var queue = typeof(LogbirdClient).GetField("_queue", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(client)!;
        return ((System.Collections.ICollection)waiters.GetValue(queue)!).Count;
    }

    /// <summary>A body that never arrives, ignores cancellation, and fails its pending read only when disposed (as on .NET Framework).</summary>
    private sealed class StalledStream : Stream
    {
        private readonly TaskCompletionSource<int> _read = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position { get => 0; set => throw new NotSupportedException(); }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => _read.Task;

#if NET
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => new(_read.Task);
#endif

        public override int Read(byte[] buffer, int offset, int count) => _read.Task.GetAwaiter().GetResult();

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            _read.TrySetException(new ObjectDisposedException(nameof(StalledStream)));
            base.Dispose(disposing);
        }
    }

    [Fact]
    public void Only_id_is_exempt_on_entities_and_only_type_and_id_on_targets()
    {
        var redactor = new Redactor(new Regex("type|id"));
        var result = redactor.Redact(JsonNode.Parse("""
            { "id": "e", "action": "a", "actor": { "type": "user", "id": "u" }, "executor": { "type": "worker", "id": "w" },
              "targets": [{ "type": "invoice", "id": "i" }] }
            """)!.AsObject());
        Assert.Equal("[redacted]", (string?)result["actor"]!["type"]);
        Assert.Equal("u", (string?)result["actor"]!["id"]);
        Assert.Equal("[redacted]", (string?)result["executor"]!["type"]);
        Assert.Equal("invoice", (string?)result["targets"]![0]!["type"]);
        Assert.Equal("i", (string?)result["targets"]![0]!["id"]);
    }

    [Fact]
    public async Task A_redaction_pattern_that_times_out_never_fails_construction()
    {
        // Nested quantifiers with a one-tick timeout: matching a field name runs out of time.
        var slow = new Regex("^((((\\w)+)+)+)+\\d$", RegexOptions.None, TimeSpan.FromTicks(1));
        Assert.Throws<RegexMatchTimeoutException>(() => slow.IsMatch("impersonator"));
        var errors = new ConcurrentQueue<Exception>();
        var options = Options(o => o.OnError = errors.Enqueue);
        options.Redaction.Keys = slow;
        await using (var client = Client(options, new FakeServer()))
        {
            Assert.True(await client.FlushAsync());
        }

        var disabled = new LogbirdOptions { Enabled = false };
        disabled.Redaction.Keys = slow;
        await using (new LogbirdClient(disabled))
        {
        }
    }

    [Fact]
    public async Task An_oversized_read_response_is_a_LogbirdApiException()
    {
        var server = new FakeServer().Then(_ =>
        {
            var response = FakeServer.Json(HttpStatusCode.OK, "{}");
            response.Content!.Headers.ContentLength = 100L * 1024 * 1024;
            return response;
        });
        using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "k" }, new HttpClient(server));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync());
        Assert.Equal("response_too_large", error.Code);
    }

    [Fact]
    public async Task A_stalled_body_cannot_outlive_the_read_timeout()
    {
        var server = new FakeServer().Then(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new StalledStream()) });
        using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "k", Timeout = TimeSpan.FromMilliseconds(300) }, new HttpClient(server));
        var watch = Stopwatch.StartNew();
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync());
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(5), watch.Elapsed.ToString());
        Assert.Equal("unreachable", error.Code);
    }

    [Fact]
    public async Task A_flush_registered_during_the_shutdown_report_waits_for_the_report()
    {
        var queue = new Internal.EventQueue(10, QueueFullBehavior.DropOldest, _ => { });
        queue.Enqueue(sequence => new Internal.QueuedEvent([1], "e1", "a", sequence), out _, out _, out _);
        var (queued, _, _) = queue.Abandon();
        Assert.Single(queued);
        var waiter = queue.AddWaiter();
        Assert.NotNull(waiter);
        queue.CompleteAllWaiters(outstandingResult: true);
        queue.CompleteSatisfiedWaiters();
        Assert.False(waiter!.Completion.Task.IsCompleted);
        queue.FinishAbandon(anyAbandoned: true);
        Assert.False(await waiter.Completion.Task);
    }

    [Fact]
    public async Task Concurrent_synchronous_disposers_both_return_after_every_drop_is_reported()
    {
        var server = new FakeServer { Fallback = _ => new TaskCompletionSource<HttpResponseMessage>().Task };
        var client = Client(Options(o => o.ShutdownTimeout = TimeSpan.FromMilliseconds(100)), server);
        for (var i = 0; i < 20; i++)
        {
            client.Track(new AuditEvent("pending"));
        }

        var seen = new ConcurrentQueue<long>();
        var disposers = Enumerable.Range(0, 2).Select(_ => Task.Run(() =>
        {
            client.Dispose();
            seen.Enqueue(client.Stats.Dropped);
        })).ToArray();
        await Task.WhenAll(disposers);
        Assert.All(seen, dropped => Assert.Equal(20, dropped));
    }

    [Fact]
    public async Task One_acknowledgement_settles_one_entry_even_when_two_entries_share_an_id()
    {
        var server = new FakeServer().Then(request =>
            FakeServer.Json(HttpStatusCode.Accepted, JsonSerializer.Serialize(new { accepted = 1, ids = new[] { "shared-id" }, rejected = Array.Empty<object>() })));
        server.Fallback = _ => Task.FromResult(FakeServer.Json(HttpStatusCode.OK, "{}"));
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o =>
        {
            o.MaxRetries = 1;
            o.OnDrop = drops.Enqueue;
        }), server);
        client.Track(new AuditEvent("first") { Id = "shared-id" });
        client.Track(new AuditEvent("second") { Id = "shared-id" });
        Assert.True(await client.FlushAsync());
        Assert.Equal(1, client.Stats.Delivered);
        Assert.Equal(DropReason.Unacknowledged, Assert.Single(drops).Reason);
    }

    [Fact]
    public async Task Host_exceptions_are_always_wrapped_and_unknown_codes_become_other()
    {
        var errors = new ConcurrentQueue<Exception>();
        var hostException = new LogbirdDeliveryException("secret-from-host");
        var server = new FakeServer().Then(request => FakeServer.Json(
            HttpStatusCode.Accepted,
            "{\"accepted\":0,\"ids\":[],\"rejected\":[{\"index\":0,\"reason\":\"x\",\"code\":\"user_secret_42\"}]}"));
        await using var client = Client(Options(o =>
        {
            o.OnError = errors.Enqueue;
            o.BeforeSend = e => e.Action == "throws" ? throw hostException : e;
        }), server);
        client.Track(new AuditEvent("throws"));
        client.Track(new AuditEvent("rejected"));
        Assert.True(await client.FlushAsync());
        Assert.DoesNotContain(errors, e => ReferenceEquals(e, hostException));
        Assert.All(errors, e => Assert.DoesNotContain("secret", e.Message, StringComparison.Ordinal));
        Assert.Equal(["other"], errors.OfType<LogbirdRejectedException>().Single().Codes);
    }

    [Fact]
    public async Task A_huge_number_array_is_caught_before_any_copy_and_drop_fields_are_bounded()
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
        var numbers = new JsonArray();
        for (var i = 0; i < 300_000; i++)
        {
            numbers.Add((JsonNode)i);
        }

        client.Track(new AuditEvent("numbers") { Metadata = { ["n"] = numbers } });
        client.Track(new AuditEvent(new string('a', 300 * 1024)));
        Assert.True(await client.FlushAsync());
        Assert.Equal(0, copies);
        Assert.All(drops, d => Assert.Equal(DropReason.TooLarge, d.Reason));
        Assert.Equal(2, drops.Count);
        Assert.All(drops, d => Assert.True(d.Action.Length <= 256));
    }

    [Fact]
    public async Task The_number_of_flush_waiters_stays_bounded()
    {
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var server = new FakeServer
        {
            Fallback = async request =>
            {
                await release.Task;
                return FakeServer.Accept(request);
            },
        };
        await using var client = Client(Options(o => o.MaxQueueSize = 100_000), server);
        var flushes = new Task<bool>[3_000];
        for (var i = 0; i < flushes.Length; i++)
        {
            client.Track(new AuditEvent("advancing"));
            flushes[i] = client.FlushAsync();
        }

        Assert.True(WaiterCount(client) <= Internal.EventQueue.MaxWaiters, WaiterCount(client).ToString(System.Globalization.CultureInfo.InvariantCulture));
        release.SetResult(true);
        Assert.All(await Task.WhenAll(flushes), Assert.True);
    }

    [Fact]
    public async Task SearchAll_can_be_bounded_by_a_page_limit()
    {
        var page = 0;
        var server = new FakeServer
        {
            Fallback = _ => Task.FromResult(FakeServer.Json(HttpStatusCode.OK, $$"""{"data":[],"nextCursor":"c{{Interlocked.Increment(ref page)}}","total":0,"tookMs":1}""")),
        };
        using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "k", MaxPages = 5 }, new HttpClient(server));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(async () =>
        {
            await foreach (var _ in reader.SearchAllAsync())
            {
            }
        });
        Assert.Equal("page_limit", error.Code);
        Assert.Equal(5, page);
    }

    [Fact]
    public async Task No_flush_completion_can_land_after_abandonment_has_started()
    {
        for (var round = 0; round < 200; round++)
        {
            var queue = new Internal.EventQueue(100, QueueFullBehavior.DropOldest, _ => { });
            var waiters = new System.Collections.Generic.List<Internal.FlushWaiter>();
            for (var i = 0; i < 20; i++)
            {
                queue.Enqueue(sequence => new Internal.QueuedEvent([1], "e" + i, "a", sequence), out _, out _, out _);
                waiters.Add(queue.AddWaiter()!);
            }

            var batch = queue.TakeBatch(10, int.MaxValue);
            foreach (var item in batch)
            {
                item.TrySettle();
            }

            queue.FinishBatch([], out _);
            var completer = Task.Run(() =>
            {
                for (var i = 0; i < 50; i++)
                {
                    queue.CompleteSatisfiedWaiters();
                }
            });
            var (_, _, decided) = queue.Abandon();
            var notDecided = waiters.Where(w => decided.All(d => d.Waiter != w)).ToList();

            // Every waiter Abandon did not decide must already have been completed before Abandon took the lock.
            Assert.All(notDecided, w => Assert.True(w.Completion.Task.IsCompleted));
            await completer;
        }
    }

    [Fact]
    public async Task A_503_acknowledging_a_duplicated_id_once_keeps_the_previous_body()
    {
        static HttpResponseMessage Pending(CapturedRequest request)
        {
            var ids = request.Ids;
            var details = new
            {
                accepted = 1,
                ids = new[] { ids[0] },
                rejected = Array.Empty<object>(),
                warnings = Array.Empty<object>(),
                indices = new[] { 2 },
                eventIds = new[] { ids[2] },
            };
            return FakeServer.Json(HttpStatusCode.ServiceUnavailable, JsonSerializer.Serialize(new { error = new { code = "ingest_pending", details } }));
        }

        // The identical 503 twice: the acknowledgement for "dup" must not be credited to the second "dup" entry.
        var server = new FakeServer().Then(Pending).Then(Pending);
        await using var client = Client(Options(), server);
        client.Track(new AuditEvent("first") { Id = "dup" });
        client.Track(new AuditEvent("second") { Id = "dup" });
        client.Track(new AuditEvent("third"));
        Assert.True(await client.FlushAsync());
        var requests = server.Requests.ToArray();
        Assert.Equal(requests[0].Body, requests[1].Body);
        Assert.Equal(requests[0].Body, requests[2].Body);
    }

    [Fact]
    public async Task A_later_503_that_marks_an_earlier_credited_entry_unresolved_credits_the_other_duplicate()
    {
        static HttpResponseMessage Pending(CapturedRequest request, int unresolvedIndex, string[] acceptedIds)
        {
            var ids = request.Ids;
            var details = new
            {
                accepted = acceptedIds.Length,
                ids = acceptedIds,
                rejected = Array.Empty<object>(),
                warnings = Array.Empty<object>(),
                indices = new[] { unresolvedIndex },
                eventIds = new[] { ids[unresolvedIndex] },
            };
            return FakeServer.Json(HttpStatusCode.ServiceUnavailable, JsonSerializer.Serialize(new { error = new { code = "ingest_pending", details } }));
        }

        // First: one A accepted, B unresolved (index 0 is credited, the details are incomplete, the body is kept).
        // Then: index 0 unresolved, [A, B] accepted, which accounts for the second A and B.
        var server = new FakeServer()
            .Then(request => Pending(request, 2, ["dup"]))
            .Then(request => Pending(request, 0, ["dup", request.Ids[2]]));
        await using var client = Client(Options(), server);
        client.Track(new AuditEvent("first") { Id = "dup" });
        client.Track(new AuditEvent("second") { Id = "dup" });
        client.Track(new AuditEvent("third"));
        Assert.True(await client.FlushAsync());
        Assert.Equal(3, client.Stats.Delivered);
        Assert.Equal(2, server.Requests.Count);
    }

    [Fact]
    public async Task Missing_and_non_protocol_rejection_codes_become_other()
    {
        var errors = new ConcurrentQueue<Exception>();
        var server = new FakeServer().Then(request => FakeServer.Json(
            HttpStatusCode.Accepted,
            "{\"accepted\":0,\"ids\":[],\"rejected\":[{\"index\":0,\"reason\":\"x\"},{\"index\":1,\"reason\":\"y\",\"code\":\"invalid_entity_id\"},{\"index\":2,\"reason\":\"z\",\"code\":7}]}"));
        await using var client = Client(Options(o => o.OnError = errors.Enqueue), server);
        client.Track(new AuditEvent("a"));
        client.Track(new AuditEvent("b"));
        client.Track(new AuditEvent("c"));
        Assert.True(await client.FlushAsync());
        Assert.Equal(["other", "other", "other"], errors.OfType<LogbirdRejectedException>().Single().Codes);
    }

    [Fact]
    public async Task A_huge_array_of_nulls_is_caught_before_any_copy()
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
        var nulls = new JsonArray();
        for (var i = 0; i < 300_000; i++)
        {
            nulls.Add((JsonNode?)null);
        }

        client.Track(new AuditEvent("nulls") { Metadata = { ["n"] = nulls } });
        Assert.True(await client.FlushAsync());
        Assert.Equal(0, copies);
        Assert.Equal(DropReason.TooLarge, Assert.Single(drops).Reason);
    }

    [Fact]
    public async Task The_earlier_SearchAll_signature_still_compiles_and_works()
    {
        var server = new FakeServer
        {
            Fallback = _ => Task.FromResult(FakeServer.Json(HttpStatusCode.OK, """{"data":[],"nextCursor":null,"total":0,"tookMs":1}""")),
        };
        using var reader = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "k" }, new HttpClient(server));
        var count = 0;
        await foreach (var _ in reader.SearchAllAsync(new EventSearch { Limit = 10 }, CancellationToken.None))
        {
            count++;
        }

        // A positional default for the token keeps compiling too.
        await foreach (var _ in reader.SearchAllAsync(new EventSearch { Limit = 10 }, default))
        {
            count++;
        }

        Assert.Equal(0, count);
        Assert.Equal(2, server.Requests.Count);
    }
}
