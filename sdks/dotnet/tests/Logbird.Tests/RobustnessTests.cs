using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Tests;

public class RobustnessTests
{
    private static readonly Uri Endpoint = new("https://audit.example.invalid/");

    /// <summary>A host-wide outgoing-HTTP auditor, the classic feedback-loop trap.</summary>
    private sealed class AuditingHandler(Func<LogbirdClient> client, HttpMessageHandler inner) : DelegatingHandler(inner)
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            client().Track(new AuditEvent("http.outgoing"));
            return base.SendAsync(request, cancellationToken);
        }
    }

    /// <summary>A synchronization context that never runs posted work, like a blocked UI thread.</summary>
    private sealed class BlockedContext : SynchronizationContext
    {
        public override void Post(SendOrPostCallback d, object? state)
        {
        }
    }

    [Fact]
    public async Task Tracking_from_inside_delivery_never_loops()
    {
        var server = new FakeServer();
        LogbirdClient? client = null;
        var options = new LogbirdOptions { Endpoint = Endpoint, IngestKey = "lb_ingest_fictional", FlushInterval = TimeSpan.FromHours(1) };
        options.OnError = _ => client!.Track(new AuditEvent("from.on.error"));
        client = new LogbirdClient(options, new HttpClient(new AuditingHandler(() => client!, server)));
        await using (client)
        {
            client.Track(new AuditEvent("real.event"));
            Assert.True(await client.FlushAsync());
            Assert.True(await client.FlushAsync());
            Assert.Equal(["real.event"], server.Requests.SelectMany(r => r.Events).Select(e => e.GetProperty("action").GetString()));
            Assert.Equal(1, client.Stats.Filtered);
        }
    }

    [Fact]
    public async Task An_OnDrop_hook_that_tracks_cannot_recurse()
    {
        LogbirdClient? client = null;
        var drops = 0;
        var options = new LogbirdOptions
        {
            Endpoint = Endpoint,
            IngestKey = "lb_ingest_fictional",
            MaxQueueSize = 1,
            QueueFullBehavior = QueueFullBehavior.DropNewest,
            FlushInterval = TimeSpan.FromHours(1),
            OnDrop = _ =>
            {
                Interlocked.Increment(ref drops);
                client!.Track(new AuditEvent("from.on.drop"));
            },
        };
        client = new LogbirdClient(options, new HttpClient(new FakeServer()));
        client.Track(new AuditEvent("a"));
        client.Track(new AuditEvent("b"));
        await client.DisposeAsync();
        client.Track(new AuditEvent("after.dispose"));
        Assert.True(await client.FlushAsync());
        Assert.Equal(2, drops);
    }

    [Fact]
    public void Synchronous_flush_and_dispose_cannot_deadlock_on_a_synchronization_context()
    {
        var previous = SynchronizationContext.Current;
        SynchronizationContext.SetSynchronizationContext(new BlockedContext());
        try
        {
            var server = new FakeServer();
            var client = new LogbirdClient(new LogbirdOptions { Endpoint = Endpoint, IngestKey = "lb_ingest_fictional", FlushInterval = TimeSpan.FromHours(1) }, new HttpClient(server));
            client.Track(new AuditEvent("console.event"));
            Assert.True(client.Flush(TimeSpan.FromSeconds(10)));
            client.Track(new AuditEvent("console.event.2"));
            client.Dispose();
            Assert.Equal(2, client.Stats.Delivered);
        }
        finally
        {
            SynchronizationContext.SetSynchronizationContext(previous);
        }
    }

    [Fact]
    public async Task Flush_with_a_timeout_returns_false_while_the_server_hangs()
    {
        var server = new FakeServer { Fallback = _ => new TaskCompletionSource<HttpResponseMessage>().Task };
        var client = new LogbirdClient(new LogbirdOptions { Endpoint = Endpoint, IngestKey = "lb_ingest_fictional", ShutdownTimeout = TimeSpan.FromMilliseconds(200) }, new HttpClient(server));
        client.Track(new AuditEvent("slow"));
        Assert.False(await client.FlushAsync(TimeSpan.FromMilliseconds(200)));
        Assert.False(client.Flush(TimeSpan.FromMilliseconds(200)));
        await client.DisposeAsync();
    }

    [Fact]
    public async Task An_unexpected_handler_exception_is_retried_and_never_loses_the_batch()
    {
        var server = new FakeServer().Then(_ => throw new InvalidOperationException("fictional handler bug"));
        await using var client = new LogbirdClient(new LogbirdOptions { Endpoint = Endpoint, IngestKey = "lb_ingest_fictional", FlushInterval = TimeSpan.FromHours(1) }, new HttpClient(server));
        client.Track(new AuditEvent("survives"));
        Assert.True(await client.FlushAsync());
        Assert.Equal(2, server.Requests.Count);
        Assert.Equal(1, client.Stats.Delivered);
    }

    [Fact]
    public async Task Large_integers_and_decimals_keep_every_digit_on_the_wire()
    {
        var server = new FakeServer();
        await using var client = new LogbirdClient(new LogbirdOptions { Endpoint = Endpoint, IngestKey = "lb_ingest_fictional" }, new HttpClient(server));
        client.Track(new AuditEvent("ledger.posted")
        {
            Metadata =
            {
                ["snowflake"] = 1_234_567_890_123_456_789L,
                ["max"] = ulong.MaxValue,
                ["amount"] = 12345678901234.567890123456m,
            },
            Changes = { new AuditChange("balance", 9_007_199_254_740_993L, 0.1m) },
        });
        Assert.True(await client.FlushAsync());
        var text = server.Requests.Single().Text;
        Assert.Contains("\"snowflake\":1234567890123456789", text);
        Assert.Contains("\"max\":18446744073709551615", text);
        Assert.Contains("\"amount\":12345678901234.567890123456", text);
        Assert.Contains("\"before\":9007199254740993,\"after\":0.1", text);
    }
}
