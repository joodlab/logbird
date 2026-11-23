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

    private static LogbirdReadClient Reader(HttpMessageHandler handler, TimeSpan? timeout = null)
        => new(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "lb_read_fictional", Timeout = timeout ?? TimeSpan.FromSeconds(30) }, new HttpClient(handler));

    private sealed class Answer(Func<HttpRequestMessage, Task<HttpResponseMessage>> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => answer(request);
    }

    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    // ---------------------------------------------------------------- (a) read client

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"nextCursor\":null}")]
    [InlineData("{\"data\":[{}],\"nextCursor\":null}")]
    public async Task An_incomplete_search_answer_is_refused_not_read_as_an_empty_page(string body)
    {
        using var reader = Reader(new Answer(_ => Task.FromResult(Json(body))));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(new EventSearch()));
        Assert.Equal("invalid_response", error.Code);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"payload\":{}}")]
    public async Task An_incomplete_event_detail_is_refused(string body)
    {
        using var reader = Reader(new Answer(_ => Task.FromResult(Json(body))));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.GetAsync("evt_1"));
        Assert.Equal("invalid_response", error.Code);
    }

    [Fact]
    public async Task A_complete_search_answer_is_still_read()
    {
        const string body = "{\"data\":[{\"id\":\"evt_1\",\"projectId\":\"prj_1\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"action\":\"invoice.paid\"}],\"nextCursor\":null,\"total\":1,\"tookMs\":1}";
        using var reader = Reader(new Answer(_ => Task.FromResult(Json(body))));
        var page = await reader.SearchAsync(new EventSearch());
        Assert.Equal("evt_1", Assert.Single(page.Events).Id);
    }

    [Fact]
    public async Task The_read_timeout_holds_even_when_the_handler_ignores_cancellation()
    {
        var never = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var reader = Reader(new Answer(_ => never.Task), TimeSpan.FromMilliseconds(200));
        var watch = Stopwatch.StartNew();
        try
        {
            var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(new EventSearch()));
            Assert.Equal("unreachable", error.Code);
            Assert.True(watch.Elapsed < TimeSpan.FromSeconds(10), watch.Elapsed.ToString());
        }
        finally
        {
            never.TrySetResult(Json("{}"));
        }
    }

    private sealed class FailingContent : HttpContent
    {
        public bool Disposed { get; private set; }

        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => throw new IOException("fictional broken body");

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
        var content = new FailingContent();
        using var reader = Reader(new Answer(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content })));
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.SearchAsync(new EventSearch()));
        Assert.Equal("unreachable", error.Code);
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
        var notifier = new Internal.Notifier(
            100,
            n => Interlocked.Add(ref lost, n),
            () => { },
            _ => throws ? throw new NotSupportedException("fictional refusal") : false);
        notifier.Post(() => Interlocked.Increment(ref ran));
        notifier.Post(() => Interlocked.Increment(ref ran));
        var waited = notifier.WaitAsync(CancellationToken.None);
        Assert.Same(waited, await Task.WhenAny(waited, Task.Delay(TimeSpan.FromSeconds(10))));
        Assert.Equal(0, ran);
        Assert.True(lost >= 1, lost.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    // ---------------------------------------------------------------- (d) sender arithmetic

    [Fact]
    public async Task A_very_large_MaxRetries_does_not_overflow_the_attempt_bound()
    {
        var server = new FakeServer().ThenStatus(HttpStatusCode.ServiceUnavailable).ThenStatus(HttpStatusCode.ServiceUnavailable);
        await using var client = new LogbirdClient(
            new LogbirdOptions { Endpoint = Endpoint, IngestKey = "lb_ingest_fictional", FlushInterval = TimeSpan.FromHours(1), MaxRetries = int.MaxValue },
            new HttpClient(server),
            logger: null,
            delay: (_, _) => Task.CompletedTask);
        client.Track(new AuditEvent("x"));
        Assert.True(await client.FlushAsync());
        Assert.Equal(1, client.Stats.Delivered);
        Assert.Equal(3, server.Requests.Count);
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
        client.Track(new AuditEvent("delivered"));
        Assert.True(await client.FlushAsync());
        client.Track(new AuditEvent("queued at shutdown"));
        await client.DisposeAsync();

        // A drop reported after shutdown (an event tracked once the client is closed) is counted too.
        client.Track(new AuditEvent("after shutdown"));
        await Task.Delay(100);
        var after = Collect();
        // The second event may still be sent while the client shuts down; either way every event is counted, and the
        // counts are still there after the client was disposed.
        Assert.Equal(2, Delta(before, after, "logbird.events.tracked"));
        Assert.Equal(3, Delta(before, after, "logbird.events.delivered") + Delta(before, after, "logbird.events.dropped:shutdown"));
        Assert.True(Delta(before, after, "logbird.events.dropped:shutdown") >= 1);
    }
}
