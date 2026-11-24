using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>Issue #190: hardening follow-ups from the core SDK's final review.</summary>
public class HardeningFollowUpTests
{
    private static readonly Uri Endpoint = new("https://audit.example.invalid/");

    private const string Version020 = "{\"info\":{\"version\":\"0.2.0\"}}";

    private const string EventJson = """
        {"id":"evt_1","projectId":"prj_1","timestamp":"2026-11-22T08:00:00.123Z","receivedAt":"2026-11-22T08:00:01.000Z",
         "environment":"staging","action":"invoice.updated","category":"invoice","outcome":"success","severity":"info",
         "description":"","actor":{"type":"user","id":"u1","name":"Fictional","email":""},"impersonator":null,
         "executor":null,"tenant":{"id":"t1","name":""},"source":null,
         "targets":[{"type":"invoice","id":"inv_1","name":"INV-1"}],"changes":[{"field":"limit","before":"24","after":"48"}],
         "context":{"operationId":"op","parentEventId":"","requestId":"req","traceId":"","ip":"","userAgent":""},
         "attributes":{"metadata.plan":"pro"},"conformance":77.8,"schemaVersion":"","sdk":"dotnet/0.1.0"}
        """;

    private static LogbirdReadClient Reader(HttpMessageHandler handler, TimeSpan? timeout = null)
        => new(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "lb_read_fictional", Timeout = timeout ?? TimeSpan.FromSeconds(30) }, new HttpClient(handler));

    /// <summary>Answers every request with <paramref name="answer"/>, which sees the transport's cancellation token.</summary>
    private sealed class Answer(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> answer) : HttpMessageHandler
    {
        public Answer(Func<HttpRequestMessage, Task<HttpResponseMessage>> answer)
            : this((request, _) => answer(request))
        {
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => answer(request, cancellationToken);
    }

    /// <summary>Answers the version read as Logbird 0.2.0 and every other request with <paramref name="answer"/>.</summary>
    private static Answer Server020(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> answer)
        => new((request, token) => request.RequestUri!.AbsolutePath == "/openapi.json" ? Task.FromResult(Json(Version020)) : answer(request, token));

    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    /// <summary>A small body that declares more than the read client accepts.</summary>
    private static HttpResponseMessage Oversized(TrackedContent? content = null)
    {
        var body = content ?? new TrackedContent("{}");
        body.Headers.ContentLength = 100_000_000;
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = body };
    }

    private sealed class TrackedContent(string text) : StringContent(text, Encoding.UTF8, "application/json")
    {
        private int _disposed;

        public bool Disposed => Volatile.Read(ref _disposed) == 1;

        protected override void Dispose(bool disposing)
        {
            Interlocked.Exchange(ref _disposed, 1);
            base.Dispose(disposing);
        }
    }

    private static async Task Eventually(Func<bool> condition)
    {
        var watch = Stopwatch.StartNew();
        while (!condition())
        {
            Assert.True(watch.Elapsed < TimeSpan.FromSeconds(10), "The condition did not hold within 10 seconds.");
            await Task.Delay(20);
        }
    }

    // ---------------------------------------------------------------- (a) read client: incomplete answers

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"nextCursor\":null}")]
    [InlineData("{\"data\":null,\"nextCursor\":null,\"total\":0,\"tookMs\":1}")]
    [InlineData("{\"data\":[],\"total\":0,\"tookMs\":1}")]
    [InlineData("{\"data\":[],\"nextCursor\":null,\"tookMs\":1}")]
    [InlineData("{\"data\":[],\"nextCursor\":null,\"total\":0}")]
    [InlineData("{\"data\":[],\"nextCursor\":null,\"total\":0,\"totalExact\":null,\"tookMs\":1}")]
    [InlineData("{\"data\":[null],\"nextCursor\":null,\"total\":1,\"tookMs\":1}")]
    [InlineData("{\"data\":[{}],\"nextCursor\":null,\"total\":1,\"tookMs\":1}")]
    public async Task An_incomplete_search_answer_is_refused_not_read_as_an_empty_page(string body)
    {
        using var reader = Reader(new Answer(_ => Task.FromResult(Json(body))));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(new EventSearch()));
        Assert.Equal("invalid_response", error.Code);
    }

    public static IEnumerable<object[]> IncompleteEvents()
    {
        // Each removes or nulls one member the event contract requires.
        foreach (var member in new[] { "\"id\":\"evt_1\",", "\"action\":\"invoice.updated\",", "\"receivedAt\":\"2026-11-22T08:00:01.000Z\",", "\"impersonator\":null,", "\"source\":null,", "\"conformance\":77.8," })
        {
            yield return [EventJson.Replace(member, string.Empty)];
        }

        yield return [EventJson.Replace("\"targets\":[{\"type\":\"invoice\",\"id\":\"inv_1\",\"name\":\"INV-1\"}]", "\"targets\":null")];
        yield return [EventJson.Replace("\"targets\":[{\"type\":\"invoice\",\"id\":\"inv_1\",\"name\":\"INV-1\"}]", "\"targets\":[{\"type\":\"invoice\",\"id\":null,\"name\":\"INV-1\"}]")];
        yield return [EventJson.Replace("\"email\":\"\"", "\"email\":null")];
        yield return [EventJson.Replace("\"context\":{\"operationId\":\"op\",", "\"context\":{")];
        yield return [EventJson.Replace("\"attributes\":{\"metadata.plan\":\"pro\"}", "\"attributes\":null")];
    }

    [Theory]
    [MemberData(nameof(IncompleteEvents))]
    public async Task A_page_with_an_incomplete_event_is_refused(string stored)
    {
        using var reader = Reader(new Answer(_ => Task.FromResult(Json("{\"data\":[" + stored + "],\"nextCursor\":null,\"total\":1,\"tookMs\":1}"))));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(new EventSearch()));
        Assert.Equal("invalid_response", error.Code);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"payload\":{}}")]
    [InlineData("{\"event\":null,\"payload\":{},\"parents\":[],\"childCount\":0,\"operationSize\":1}")]
    [InlineData("{\"event\":EVENT,\"parents\":[],\"childCount\":0,\"operationSize\":1}")]
    [InlineData("{\"event\":EVENT,\"payload\":{},\"parents\":null,\"childCount\":0,\"operationSize\":1}")]
    [InlineData("{\"event\":EVENT,\"payload\":{},\"parents\":[null],\"childCount\":0,\"operationSize\":1}")]
    [InlineData("{\"event\":EVENT,\"payload\":{},\"parents\":[],\"operationSize\":1}")]
    [InlineData("{\"event\":EVENT,\"payload\":{},\"parents\":[],\"childCount\":0}")]
    public async Task An_incomplete_event_detail_is_refused(string body)
    {
        using var reader = Reader(new Answer(_ => Task.FromResult(Json(body.Replace("EVENT", EventJson)))));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.GetEventAsync("evt_1"));
        Assert.Equal("invalid_response", error.Code);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"field\":\"outcome\",\"values\":[],\"otherCount\":0}")]
    [InlineData("{\"field\":\"outcome\",\"by\":null,\"values\":null,\"otherCount\":0}")]
    [InlineData("{\"field\":\"outcome\",\"by\":null,\"values\":[null],\"otherCount\":0}")]
    [InlineData("{\"field\":\"outcome\",\"by\":null,\"values\":[{\"value\":\"success\",\"label\":\"success\"}],\"otherCount\":0}")]
    [InlineData("{\"field\":\"outcome\",\"by\":\"tenant\",\"values\":[{\"value\":\"success\",\"label\":\"success\",\"count\":1,\"groups\":null}],\"otherCount\":0}")]
    [InlineData("{\"field\":\"outcome\",\"by\":null,\"values\":[]}")]
    public async Task An_incomplete_facet_answer_is_refused(string body)
    {
        using var reader = Reader(Server020((_, _) => Task.FromResult(Json(body))));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.FacetsAsync(new FacetQuery("outcome")));
        Assert.Equal("invalid_response", error.Code);
    }

    [Fact]
    public async Task Complete_answers_are_still_read_with_their_optional_members_absent()
    {
        var page = "{\"data\":[" + EventJson + "],\"nextCursor\":null,\"total\":1,\"tookMs\":1}";
        var detail = "{\"event\":" + EventJson + ",\"payload\":null,\"parents\":[" + EventJson + "],\"childCount\":0,\"operationSize\":1}";
        const string facets = "{\"field\":\"outcome\",\"by\":null,\"values\":[{\"value\":\"success\",\"label\":\"success\",\"count\":1}],\"otherCount\":0}";
        using var reader = Reader(Server020((request, _) => Task.FromResult(Json(
            request.RequestUri!.AbsolutePath == "/v1/facets" ? facets
            : request.RequestUri.AbsolutePath == "/v1/events" ? page
            : detail))));

        var read = await reader.SearchAsync(new EventSearch());
        Assert.Equal("evt_1", Assert.Single(read.Events).Id);
        Assert.Null(read.NextCursor);
        Assert.Null(read.TotalExact);
        Assert.Equal("evt_1", (await reader.GetEventAsync("evt_1"))!.Event.Id);
        Assert.Equal(1, Assert.Single((await reader.FacetsAsync(new FacetQuery("outcome"))).Values).Count);
    }

    // ---------------------------------------------------------------- (a) read client: timeout and ownership

    [Fact]
    public async Task The_read_timeout_holds_even_when_the_handler_ignores_cancellation()
    {
        var never = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
            {
                using var reader = Reader(new Answer(_ => never.Task), TimeSpan.FromMilliseconds(200));
                var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(new EventSearch()));
                Assert.Equal("unreachable", error.Code);
            });
        }
        finally
        {
            never.TrySetResult(Json("{}"));
        }
    }

    [Fact]
    public async Task A_callback_that_blocks_cancellation_of_the_transport_cannot_hold_the_timeout()
    {
        var release = new ManualResetEventSlim();
        var never = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
            {
                using var reader = Reader(
                    new Answer((_, token) =>
                    {
                        // A component that blocks inside its cancellation callback, as a response disposal can.
                        token.Register(() => release.Wait());
                        return never.Task;
                    }),
                    TimeSpan.FromMilliseconds(200));
                var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(new EventSearch()));
                Assert.Equal("unreachable", error.Code);
            });
        }
        finally
        {
            release.Set();
            never.TrySetResult(Json("{}"));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Once_the_timeout_or_the_caller_wins_a_late_answer_cannot_change_the_outcome(bool callerCancels)
    {
        var late = new TrackedContent("{}");
        var handler = new Answer(async (_, token) =>
        {
            // A cooperating handler that answers (with a body over the limit) as soon as it is cancelled.
            try
            {
                await Task.Delay(Timeout.Infinite, token);
            }
            catch (OperationCanceledException)
            {
            }

            return Oversized(late);
        });
        using var reader = Reader(handler, callerCancels ? TimeSpan.FromMinutes(1) : TimeSpan.FromMilliseconds(200));
        using var caller = new CancellationTokenSource();
        await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
        {
            if (callerCancels)
            {
                caller.CancelAfter(200);
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.SearchAsync(new EventSearch(), caller.Token));
            }
            else
            {
                var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(new EventSearch()));
                Assert.Equal("unreachable", error.Code);
            }
        });

        // The late response is disposed without its body being read.
        await Eventually(() => late.Disposed);
    }

    [Fact]
    public async Task A_caller_that_cancels_while_the_answer_arrives_gets_the_cancellation()
    {
        const string page = "{\"data\":[],\"nextCursor\":null,\"total\":0,\"tookMs\":1}";
        for (var i = 0; i < 20; i++)
        {
            using var caller = new CancellationTokenSource();
            using var reader = Reader(new Answer(_ =>
            {
                // The caller gives up while the server is answering: the cancellation decides, not the answer.
                caller.Cancel();
                return Task.FromResult(Json(page));
            }));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.SearchAsync(new EventSearch(), caller.Token));
        }
    }

    [Fact]
    public async Task A_member_name_with_a_lone_surrogate_is_an_invalid_response()
    {
        const string page = "{\"data\":[],\"nextCursor\":null,\"total\":0,\"tookMs\":1,\"\\ud800\":1}";
        using var reader = Reader(new Answer(_ => Task.FromResult(Json(page))));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(new EventSearch()));
        Assert.Equal("invalid_response", error.Code);
    }

    [Fact]
    public async Task A_caller_that_already_cancelled_sends_nothing()
    {
        var sent = 0;
        var handler = new Answer(request =>
        {
            Interlocked.Increment(ref sent);
            return Task.FromResult(request.RequestUri!.AbsolutePath == "/openapi.json" ? Json(Version020) : Json("{}"));
        });
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();

        // On a fresh client (no version read yet, so not even the version is asked for) and on one that already read it.
        foreach (var warm in new[] { false, true })
        {
            using var reader = Reader(handler);
            if (warm)
            {
                await reader.FacetsAsync(new FacetQuery("outcome")).ContinueWith(_ => { });
            }

            Interlocked.Exchange(ref sent, 0);
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.SearchAsync(new EventSearch(), cancelled.Token));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.SearchAsync(new EventSearch { Query = "record:\"invoice:inv_1\"" }, cancelled.Token));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.FacetsAsync(new FacetQuery("outcome"), cancelled.Token));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.MintViewerTokenAsync(new ViewerScope("biz_1"), cancellationToken: cancelled.Token));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Jsonl), new MemoryStream(), cancelled.Token));
            Assert.Equal(0, Volatile.Read(ref sent));
        }
    }

    /// <summary>A body whose disposal blocks until released.</summary>
    private sealed class BlockingDisposeContent(ManualResetEventSlim release) : StringContent("{}", Encoding.UTF8, "application/json")
    {
        protected override void Dispose(bool disposing)
        {
            release.Wait();
            base.Dispose(disposing);
        }
    }

    [Fact]
    public async Task A_response_whose_disposal_blocks_cannot_hold_a_cancelled_call()
    {
        // Each round's disposal stays blocked until that round's call has returned, then is released, so blocked disposals
        // never pile up and starve the thread pool (which would stall the test for its own reasons on a small runner).
        for (var i = 0; i < 5; i++)
        {
            var release = new ManualResetEventSlim();
            try
            {
                await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
                {
                    using var caller = new CancellationTokenSource();
                    using var reader = Reader(new Answer(_ =>
                    {
                        caller.Cancel();
                        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new BlockingDisposeContent(release) });
                    }));
                    await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.SearchAsync(new EventSearch(), caller.Token));
                });
            }
            finally
            {
                release.Set();
            }
        }
    }

    [Fact]
    public async Task An_export_waits_for_its_headers_no_longer_than_the_read_timeout()
    {
        var never = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
            {
                using var reader = Reader(Server020((_, _) => never.Task), TimeSpan.FromMilliseconds(200));
                using var destination = new MemoryStream();
                var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Jsonl), destination));
                Assert.Equal("unreachable", error.Code);
                Assert.Equal(0, destination.Length);
            });
        }
        finally
        {
            never.TrySetResult(Json("[]"));
        }
    }

    [Fact]
    public async Task An_export_body_is_not_bound_by_the_read_timeout()
    {
        var body = new string('x', 1000);
        using var reader = Reader(Server020((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new SlowContent(body, TimeSpan.FromMilliseconds(2500)) })), TimeSpan.FromSeconds(1));
        using var destination = new MemoryStream();
        Assert.Equal(body.Length, await reader.ExportAsync(new ExportQuery(ExportFormat.Jsonl), destination));
    }

    /// <summary>A body that starts arriving only after a delay.</summary>
    private sealed class SlowContent : HttpContent
    {
        private readonly string text;
        private readonly TimeSpan delay;

        public SlowContent(string text, TimeSpan delay)
        {
            this.text = text;
            this.delay = delay;
            Headers.TryAddWithoutValidation("Content-Type", "application/x-ndjson");
        }

        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context)
        {
            await Task.Delay(delay);
            var bytes = Encoding.UTF8.GetBytes(text);
            await stream.WriteAsync(bytes, 0, bytes.Length);
        }

        protected override bool TryComputeLength(out long length)
        {
            length = -1;
            return false;
        }
    }

    [Fact]
    public async Task An_oversized_version_answer_is_unreachable_not_an_internal_exception()
    {
        using var reader = Reader(new Answer(_ => Task.FromResult(Oversized())));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.FacetsAsync(new FacetQuery("outcome")));
        Assert.Equal("unreachable", error.Code);
    }

    [Fact]
    public async Task An_oversized_answer_is_response_too_large_with_its_status()
    {
        using var reader = Reader(new Answer(_ => Task.FromResult(Oversized())));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(new EventSearch()));
        Assert.Equal("response_too_large", error.Code);
        Assert.Equal(HttpStatusCode.OK, error.StatusCode);
    }

    [Fact]
    public async Task A_handler_that_reports_an_oversized_answer_before_its_headers_is_response_too_large()
    {
        using var reader = Reader(new Answer(_ => throw new InvalidDataException("fictional limit")));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(new EventSearch()));
        Assert.Equal("response_too_large", error.Code);
        Assert.Null(error.StatusCode);
    }

    private sealed class FailingContent(Exception failure) : HttpContent
    {
        public bool Disposed { get; private set; }

        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => throw failure;

        protected override bool TryComputeLength(out long length)
        {
            length = -1;
            return false;
        }

        protected override void Dispose(bool disposing)
        {
            Disposed = true;
            base.Dispose(disposing);
        }
    }

    [Fact]
    public async Task A_failed_body_read_still_disposes_the_response()
    {
        var content = new FailingContent(new IOException("fictional broken body"));
        using var reader = Reader(new Answer(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content })));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(new EventSearch()));
        Assert.Equal("unreachable", error.Code);
        Assert.True(content.Disposed);
    }

    [Fact]
    public async Task A_body_read_failing_with_any_exception_still_disposes_the_response()
    {
        // Any exception from the body is a transport failure (step-4 A17): reported as unreachable without its message, and
        // the response is still disposed.
        var content = new FailingContent(new InvalidOperationException("fictional content fault"));
        using var reader = Reader(new Answer(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content })));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(new EventSearch()));
        Assert.Equal("unreachable", error.Code);
        Assert.DoesNotContain("fictional content fault", error.Message, StringComparison.Ordinal);
        Assert.True(content.Disposed);
    }

    // ---------------------------------------------------------------- (c) notifier scheduling failure

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Notifications_the_thread_pool_refuses_are_counted_lost_and_release_their_waiters(bool throws)
    {
        var lost = 0;
        var ran = 0;
        var entered = new ManualResetEventSlim();
        var refuse = new ManualResetEventSlim();
        var notifier = new Internal.Notifier(
            100,
            n => Interlocked.Add(ref lost, n),
            () => { },
            _ =>
            {
                entered.Set();
                refuse.Wait();
                return throws ? throw new NotSupportedException("fictional refusal") : false;
            });

        // The first post starts the drain and is held inside the scheduler; the second joins the pending backlog, and a
        // waiter registers for both before the scheduler refuses.
        var first = Task.Run(() => notifier.Post(() => Interlocked.Increment(ref ran)));
        Assert.True(entered.Wait(TimeSpan.FromSeconds(10)));
        notifier.Post(() => Interlocked.Increment(ref ran));
        var waited = notifier.WaitAsync(CancellationToken.None);
        Assert.False(waited.IsCompleted);

        refuse.Set();
        await first;
        Assert.Same(waited, await Task.WhenAny(waited, Task.Delay(TimeSpan.FromSeconds(10))));
        Assert.Equal(0, ran);
        Assert.Equal(2, lost);
    }

    // ---------------------------------------------------------------- (d) sender arithmetic

    [Fact]
    public async Task A_very_large_MaxRetries_does_not_overflow_the_attempt_bound()
    {
        // Two events in one batch: in int arithmetic, 2 + int.MaxValue - 1 wraps negative and ends the first attempt.
        var server = new FakeServer().ThenStatus(HttpStatusCode.ServiceUnavailable).ThenStatus(HttpStatusCode.ServiceUnavailable);
        await using var client = new LogbirdClient(
            new LogbirdOptions { Endpoint = Endpoint, IngestKey = "lb_ingest_fictional", FlushInterval = TimeSpan.FromHours(1), MaxRetries = int.MaxValue },
            new HttpClient(server),
            logger: null,
            delay: (_, _) => Task.CompletedTask);
        client.Track(new AuditEvent("x"));
        client.Track(new AuditEvent("y"));
        Assert.True(await client.FlushAsync());
        Assert.Equal(2, client.Stats.Delivered);
        Assert.Equal(0, client.Stats.Dropped);
        var requests = server.Requests.ToArray();
        Assert.Equal(3, requests.Length);
        Assert.All(requests, request => Assert.Equal(2, request.Events.Length));
    }

    // ---------------------------------------------------------------- (e) numbers and parsed strings

    [Theory]
    [InlineData(double.MaxValue)]
    [InlineData(double.MinValue)]
    [InlineData(double.Epsilon)]
    [InlineData(1.7976931348623155E+308)]
    [InlineData(0.1)]
    public void The_shortest_text_of_an_extreme_double_reads_back_exactly(double value)
    {
        var text = Internal.JsJson.Shortest(value);
        Assert.Equal(value, double.Parse(text, System.Globalization.CultureInfo.InvariantCulture));
    }

    [Theory]
    [InlineData(float.MaxValue)]
    [InlineData(float.MinValue)]
    [InlineData(float.Epsilon)]
    public void The_shortest_text_of_an_extreme_float_reads_back_exactly(float value)
    {
        var text = Internal.JsJson.Shortest(value);
        Assert.Equal(value, float.Parse(text, System.Globalization.CultureInfo.InvariantCulture));
    }

    [Theory]
    [InlineData("{\"k\":\"a\\ud800b\"}", "{\"k\":\"a\\ud800b\"}")]
    [InlineData("{\"k\":\"a\\uD800b\"}", "{\"k\":\"a\\ud800b\"}")]
    [InlineData("{\"k\":\"\\udc00\"}", "{\"k\":\"\\udc00\"}")]
    [InlineData("{\"k\":\"q\\\"b\\\\s\\/n\\n\"}", "{\"k\":\"q\\\"b\\\\s/n\\n\"}")]
    [InlineData("{\"k\":\"\\u00e9\\ud83d\\ude00\"}", "{\"k\":\"\u00e9\ud83d\ude00\"}")]
    public void A_parsed_string_keeps_its_code_units_and_is_written_as_JavaScript_does(string parsed, string expected)
    {
        var json = Internal.JsJson.ToUtf8(JsonNode.Parse(parsed)!);
        Assert.Equal(expected, Encoding.UTF8.GetString(json));
    }

    [Fact]
    public async Task An_event_with_a_parsed_lone_surrogate_is_tracked_and_sent_as_parsed()
    {
        var server = new FakeServer();
        await using var client = new LogbirdClient(
            new LogbirdOptions { Endpoint = Endpoint, IngestKey = "lb_ingest_fictional", FlushInterval = TimeSpan.FromHours(1) },
            new HttpClient(server));
        client.Track(new AuditEvent("x") { Metadata = { ["parsed"] = JsonNode.Parse("{\"k\":\"a\\ud800b\"}") } });
        Assert.True(await client.FlushAsync());
        Assert.Equal(1, client.Stats.Tracked);
        Assert.Equal(0, client.Stats.Dropped);
        Assert.Contains("\"k\":\"a\\ud800b\"", Assert.Single(server.Requests).Text);
    }

    // ---------------------------------------------------------------- the reusable warning list

    [Fact]
    public void A_large_warning_list_is_let_go_even_when_its_event_is_dropped()
    {
        var client = new LogbirdClient(
            new LogbirdOptions { Endpoint = Endpoint, IngestKey = "lb_ingest_fictional", FlushInterval = TimeSpan.FromHours(1) },
            new HttpClient(new FakeServer()));
        try
        {
            // This thread's list exists and is small.
            client.Track(new AuditEvent("w").Target("record", " r "));
            Assert.NotNull(LogbirdClient.IdentifierWarningCapacity);

            // 300 identifiers with surrounding whitespace (300 warnings) on an event that passes the shape check but is
            // over 256 KB once written (50,000 control characters, six bytes each escaped), so it is dropped after the
            // identifiers were inspected.
            var oversized = new AuditEvent("x") { Description = new string((char)1, 50_000) };
            for (var i = 0; i < 300; i++)
            {
                oversized.Target("record", " r" + i.ToString(System.Globalization.CultureInfo.InvariantCulture) + " ");
            }

            client.Track(oversized);
            Assert.Equal(1, client.Stats.Dropped);
            Assert.Equal(1, client.Stats.Tracked);
            Assert.Null(LogbirdClient.IdentifierWarningCapacity);

            // A small event keeps its list for reuse.
            client.Track(new AuditEvent("y").Target("record", " r "));
            Assert.NotNull(LogbirdClient.IdentifierWarningCapacity);
            Assert.True(LogbirdClient.IdentifierWarningCapacity <= 256);
        }
        finally
        {
            client.Dispose();
        }
    }
}

/// <summary>The meters read process-wide totals, so these run alone to measure exact differences.</summary>
[Collection(nameof(MeterTotalsTests))]
[CollectionDefinition(nameof(MeterTotalsTests), DisableParallelization = true)]
public class MeterTotalsTests
{
    private static Dictionary<string, long> Collect()
    {
        var values = new ConcurrentDictionary<string, long>();
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
        listener.SetMeasurementEventCallback<long>((instrument, value, tags, _) =>
        {
            var reason = string.Empty;
            foreach (var tag in tags)
            {
                if (tag.Key == "reason")
                {
                    reason = ":" + tag.Value;
                }
            }

            values.AddOrUpdate(instrument.Name + reason, value, (_, old) => old + value);
        });
        listener.Start();
        listener.RecordObservableInstruments();
        return new Dictionary<string, long>(values);
    }

    private static long Delta(Dictionary<string, long> before, Dictionary<string, long> after, string name)
        => (after.TryGetValue(name, out var a) ? a : 0) - (before.TryGetValue(name, out var b) ? b : 0);

    [Fact]
    public async Task Counters_keep_what_a_client_counted_after_it_is_disposed()
    {
        var before = Collect();
        var client = new LogbirdClient(
            new LogbirdOptions { Endpoint = new Uri("https://audit.example.invalid/"), IngestKey = "lb_ingest_fictional", FlushInterval = TimeSpan.FromHours(1), ShutdownTimeout = TimeSpan.Zero },
            new HttpClient(new FakeServer()));
        // Queue length is the one live value: it follows the client's queue. Measured before the first flush, when no
        // delivery is running (the flush interval is an hour and one event does not fill a batch).
        client.Track(new AuditEvent("delivered"));
        Assert.Equal(1, Delta(before, Collect(), "logbird.queue.length"));
        Assert.True(await client.FlushAsync());
        Assert.Equal(0, Delta(before, Collect(), "logbird.queue.length"));

        client.Track(new AuditEvent("queued at shutdown"));
        await client.DisposeAsync();

        // A drop reported after shutdown (an event tracked once the client is closed) is counted too, synchronously.
        client.Track(new AuditEvent("after shutdown"));
        var after = Collect();

        // The second event may still be sent while the client shuts down; either way every event is counted, and the
        // counts are still there after the client was disposed.
        Assert.Equal(2, Delta(before, after, "logbird.events.tracked"));
        Assert.Equal(3, Delta(before, after, "logbird.events.delivered") + Delta(before, after, "logbird.events.dropped:shutdown"));
        Assert.True(Delta(before, after, "logbird.events.dropped:shutdown") >= 1);
        Assert.Equal(0, Delta(before, after, "logbird.queue.length"));
    }
}
