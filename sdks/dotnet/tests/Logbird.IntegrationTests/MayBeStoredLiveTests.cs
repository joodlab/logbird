using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Xunit.Abstractions;

namespace Logbird.IntegrationTests;

/// <summary>
/// <see cref="DroppedEvent.MayBeStored"/> against a real server: a dropped event whose answer was lost after the server
/// stored it is found stored; one whose request never reached the server is not; one the server refused is reported as
/// not stored and is not there.
/// </summary>
public class MayBeStoredLiveTests(ITestOutputHelper output)
{
    /// <summary>Loses every answer: either after the server answered (it stored the batch) or before the request leaves.</summary>
    private sealed class LosingHandler(bool forwardFirst) : DelegatingHandler(new HttpClientHandler { AllowAutoRedirect = false })
    {
        public int Forwarded;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (forwardFirst)
            {
                using var response = await base.SendAsync(request, cancellationToken).ConfigureAwait(false);
                Interlocked.Increment(ref Forwarded);
            }

            throw new HttpRequestException("fictional connection reset after " + (forwardFirst ? "the server answered" : "nothing was sent"));
        }
    }

    private static async Task<DroppedEvent> DropThroughAsync(HttpMessageHandler handler, string id, Action<LogbirdOptions>? configure = null)
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var client = new LogbirdClient(
            LiveServer.Options(o =>
            {
                o.OnDrop = drops.Enqueue;
                o.MaxRetries = 0;
                o.ShutdownTimeout = TimeSpan.Zero;
                configure?.Invoke(o);
            }),
            new HttpClient(handler));
        client.Track(new AuditEvent("maybe-stored.checked") { Id = id });
        await client.FlushAsync();
        await client.DisposeAsync();
        return Assert.Single(drops);
    }

    private static async Task<bool> StoredWithinAsync(LogbirdReadClient reader, string id, TimeSpan wait)
    {
        var until = DateTime.UtcNow + wait;
        while (DateTime.UtcNow < until)
        {
            if (await reader.GetEventAsync(id) is not null)
            {
                return true;
            }

            await Task.Delay(500);
        }

        return await reader.GetEventAsync(id) is not null;
    }

    [LiveFact]
    public async Task A_dropped_event_that_may_be_stored_is_found_and_one_that_was_never_delivered_is_not()
    {
        using var reader = LiveServer.Reader();

        // 1. The server stored the batch, then the answer was lost: dropped, MayBeStored, and there.
        var storedId = LogbirdClient.NewEventId();
        using var afterAnswer = new LosingHandler(forwardFirst: true);
        var lostAnswer = await DropThroughAsync(afterAnswer, storedId);
        Assert.True(afterAnswer.Forwarded > 0);
        Assert.True(lostAnswer.MayBeStored, $"{lostAnswer.Reason} should say the event may be stored");
        Assert.True(await StoredWithinAsync(reader, storedId, TimeSpan.FromSeconds(30)), "the server should have stored it");

        // 2. The request never left: dropped, MayBeStored (the SDK cannot know), and not there.
        var unsentId = LogbirdClient.NewEventId();
        using var beforeSending = new LosingHandler(forwardFirst: false);
        var neverArrived = await DropThroughAsync(beforeSending, unsentId);
        Assert.True(neverArrived.MayBeStored);
        Assert.False(await StoredWithinAsync(reader, unsentId, TimeSpan.FromSeconds(10)));

        // 3. The server refused it (a fictional ingest key): dropped, not MayBeStored, and not there.
        var refusedId = LogbirdClient.NewEventId();
        var refused = await DropThroughAsync(new HttpClientHandler { AllowAutoRedirect = false }, refusedId, o => o.IngestKey = "lb_ingest_" + Guid.NewGuid().ToString("N"));
        Assert.Equal(DropReason.HttpError, refused.Reason);
        Assert.False(refused.MayBeStored);
        Assert.False(await StoredWithinAsync(reader, refusedId, TimeSpan.FromSeconds(5)));

        output.WriteLine($"server {await LiveServer.ServerVersionAsync()}");
        output.WriteLine($"answer lost after storing: {lostAnswer.Reason}, MayBeStored {lostAnswer.MayBeStored}, found stored");
        output.WriteLine($"never reached the server: {neverArrived.Reason}, MayBeStored {neverArrived.MayBeStored}, not found");
        output.WriteLine($"refused by the server: {refused.Reason}, MayBeStored {refused.MayBeStored}, not found");
    }
}
