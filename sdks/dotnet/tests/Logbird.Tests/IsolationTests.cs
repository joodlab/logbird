using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>Host code on Logbird's paths (hooks, listeners, contexts) cannot break, block or bypass its guarantees.</summary>
public class IsolationTests
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

    private static JsonNode Chain(int depth)
    {
        JsonNode node = new JsonObject { ["leaf"] = true };
        for (var i = 0; i < depth; i++)
        {
            node = new JsonObject { ["n"] = node };
        }

        return node;
    }

    [Fact]
    public async Task BeforeSend_returning_the_callers_event_with_deep_data_is_still_checked()
    {
        var original = new AuditEvent("enriched.by.hook");
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o =>
        {
            o.OnDrop = drops.Enqueue;
            o.BeforeSend = _ =>
            {
                original.Metadata["tree"] = Chain(100_000);
                return original;
            };
        }), new FakeServer());
        client.Track(original);
        Assert.True(await client.FlushAsync());
        Assert.Equal(DropReason.Invalid, Assert.Single(drops).Reason);
    }

    [Fact]
    public void Public_deep_copy_entry_points_refuse_trees_too_deep_to_walk()
    {
        var deep = new AuditEvent("deep") { Metadata = { ["tree"] = Chain(100_000) } };
        Assert.Throws<InvalidOperationException>(() => deep.Clone());
        Assert.Throws<ArgumentException>(() => new Redactor().Redact(new JsonObject { ["metadata"] = Chain(100_000) }));
    }

    [Fact]
    public async Task A_blocking_metrics_listener_never_runs_on_Track_or_shutdown()
    {
        using var block = new ManualResetEventSlim();
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
        listener.SetMeasurementEventCallback<long>((_, _, _, _) => block.Wait());
        listener.Start();
        try
        {
            var client = Client(Options(o => o.MaxQueueSize = 5), new FakeServer());
            var watch = Stopwatch.StartNew();
            for (var i = 0; i < 100; i++)
            {
                client.Track(new AuditEvent("measured"));
            }

            Assert.True(await client.FlushAsync(TimeSpan.FromSeconds(10)));
            await client.DisposeAsync();
            Assert.True(watch.Elapsed < TimeSpan.FromSeconds(10), watch.Elapsed.ToString());
            Assert.Equal(95, client.Stats.Dropped);
        }
        finally
        {
            block.Set();
        }
    }

    [Fact]
    public void Observable_instruments_report_the_clients_counters()
    {
        long tracked = -1;
        using var listener = new MeterListener
        {
            InstrumentPublished = (instrument, l) =>
            {
                if (instrument.Meter.Name == "Logbird" && instrument.Name == "logbird.events.tracked")
                {
                    l.EnableMeasurementEvents(instrument);
                }
            },
        };
        listener.SetMeasurementEventCallback<long>((_, value, _, _) => tracked = value);
        listener.Start();
        var client = Client(Options(), new FakeServer());
        try
        {
            client.Track(new AuditEvent("counted"));
            listener.RecordObservableInstruments();
            Assert.True(tracked >= 1, tracked.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
        finally
        {
            client.Dispose();
        }
    }

    [Fact]
    public async Task Callbacks_still_run_when_the_host_has_suppressed_execution_context_flow()
    {
        var errors = new ConcurrentQueue<Exception>();
        await using var client = Client(Options(o => o.OnError = errors.Enqueue), new FakeServer());
        var flow = ExecutionContext.SuppressFlow();
        try
        {
            client.Track(new AuditEvent("x") { Actor = AuditActor.User(" spaced ") });
        }
        finally
        {
            flow.Undo();
        }

        Assert.True(await client.FlushAsync(TimeSpan.FromSeconds(10)));
        Assert.Single(errors.OfType<LogbirdEventWarning>());
    }

    [Fact]
    public async Task A_failed_flush_returns_after_its_failure_callbacks_have_run()
    {
        var server = new FakeServer { Fallback = _ => Task.FromResult(FakeServer.Json(HttpStatusCode.ServiceUnavailable, "{}")) };
        var errors = new ConcurrentQueue<Exception>();
        await using var client = Client(Options(o =>
        {
            o.MaxRetries = 0;
            o.OnError = e =>
            {
                Thread.Sleep(100);
                errors.Enqueue(e);
            };
        }), server);
        client.Track(new AuditEvent("failing"));
        Assert.False(await client.FlushAsync());
        Assert.Single(errors);
    }

    [Fact]
    public async Task Skipped_notifications_never_satisfy_an_earlier_flush()
    {
        using var block = new ManualResetEventSlim();
        var calls = 0;
        await using var client = Client(Options(o =>
        {
            o.MaxQueueSize = 1;
            o.QueueFullBehavior = QueueFullBehavior.DropNewest;
            o.OnDrop = _ =>
            {
                Interlocked.Increment(ref calls);
                block.Wait();
            };
        }), new FakeServer());
        client.Track(new AuditEvent("kept"));
        client.Track(new AuditEvent("dropped.first"));
        var flush = client.FlushAsync();

        // Overflow the notification backlog (capacity 1,000); the skipped ones must not complete the flush above.
        for (var i = 0; i < 1_500; i++)
        {
            client.Track(new AuditEvent("dropped.more"));
        }

        await Task.Delay(300);
        Assert.False(flush.IsCompleted);
        block.Set();
        Assert.True(await flush);
        Assert.True(calls >= 1);
    }

    [Fact]
    public async Task Server_warning_messages_and_logs_carry_no_event_data()
    {
        var server = new FakeServer().Then(request => FakeServer.Json(
            HttpStatusCode.Accepted,
            "{\"accepted\":1,\"ids\":[\"" + request.Ids[0] + "\"],\"rejected\":[],\"warnings\":[{\"index\":0,\"reason\":\"occurredAt: value 'secret-ish' is outside the window\"}]}"));
        var errors = new ConcurrentQueue<Exception>();
        await using var client = Client(Options(o => o.OnError = errors.Enqueue), server);
        client.Track(new AuditEvent("private.action"));
        Assert.True(await client.FlushAsync());
        var warning = Assert.Single(errors.OfType<LogbirdEventWarning>());
        Assert.Equal("Logbird warning about a stored event: server warning (occurredAt)", warning.Message);
        Assert.Contains("secret-ish", warning.Reason);
        Assert.Equal("private.action", warning.Action);
    }

    [Fact]
    public async Task Throwing_callbacks_are_swallowed_and_counted()
    {
        await using var client = Client(Options(o =>
        {
            o.MaxQueueSize = 1;
            o.OnDrop = _ => throw new InvalidOperationException("fictional");
            o.OnError = _ => throw new InvalidOperationException("fictional");
        }), new FakeServer());
        client.Track(new AuditEvent("kept"));
        client.Track(new AuditEvent("dropped") { Actor = AuditActor.User(" spaced ") });
        Assert.True(await client.FlushAsync());
        Assert.True(client.CallbackFailures >= 2, client.CallbackFailures.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public void Non_finite_and_tiny_doubles_are_written_like_javascript()
    {
        Assert.Equal("null", Internal.JsJson.Shortest(double.NaN));
        Assert.Equal("null", Internal.JsJson.Shortest(double.PositiveInfinity));
        Assert.Equal("5e-324", Internal.JsJson.FormatNumber(Internal.JsJson.Shortest(double.Epsilon)));
        Assert.Equal("0.1", Internal.JsJson.FormatNumber(Internal.JsJson.Shortest(0.1)));
        Assert.Equal("1.1", Internal.JsJson.FormatNumber(Internal.JsJson.Shortest(1.1f)));
    }
}
