using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>
/// Server rules the client must respect. (1) <c>occurredAt</c> is sent as an ISO 8601 string with an explicit offset,
/// never as a number: the server resolves fractional epoch numbers at double precision, and that is frozen as part of
/// stored events' identity. (2) An event nested deeper than 1,000 levels that carries a number a double cannot hold is
/// rejected by the server; the client never sends anything close to that depth.
/// </summary>
public class ServerRulesTests
{
    private static LogbirdClient Client(FakeServer server, ConcurrentQueue<DroppedEvent>? drops = null) => new(
        new LogbirdOptions
        {
            Endpoint = new Uri("https://audit.example.invalid"),
            IngestKey = "lb_ingest_fictional",
            FlushInterval = TimeSpan.FromHours(1),
            OnDrop = drops is null ? null : drops.Enqueue,
        },
        new HttpClient(server));

    [Fact]
    public async Task OccurredAt_is_always_an_ISO_8601_UTC_string_with_milliseconds_never_a_number()
    {
        var server = new FakeServer();
        await using (var client = Client(server))
        {
            // A local offset and sub-millisecond ticks: sent as the UTC instant, to the millisecond, with a Z offset.
            client.Track(new AuditEvent("explicit.offset") { OccurredAt = new DateTimeOffset(2026, 11, 22, 10, 0, 0, 123, TimeSpan.FromHours(5)).AddTicks(4_567) });
            client.Track(new AuditEvent("explicit.utc") { OccurredAt = new DateTimeOffset(2026, 11, 22, 5, 0, 0, TimeSpan.Zero) });
            client.Track(new AuditEvent("default.now"));
            Assert.True(await client.FlushAsync());
        }

        var events = server.Requests.SelectMany(r => r.Events).ToArray();
        Assert.Equal(3, events.Length);
        foreach (var e in events)
        {
            var at = e.GetProperty("occurredAt");
            Assert.Equal(JsonValueKind.String, at.ValueKind);
            Assert.Matches(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", at.GetString());
        }

        Assert.Equal("2026-11-22T05:00:00.123Z", events[0].GetProperty("occurredAt").GetString());
        Assert.Equal("2026-11-22T05:00:00.000Z", events[1].GetProperty("occurredAt").GetString());
    }

    [Fact]
    public async Task Nothing_sent_comes_near_the_servers_1000_level_depth_rule()
    {
        var server = new FakeServer();
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using (var client = Client(server, drops))
        {
            client.Track(new AuditEvent("deep.allowed") { Metadata = { ["tree"] = Chain(40), ["big"] = JsonValue.Create(9_007_199_254_740_993L) } });
            client.Track(new AuditEvent("deep.refused") { Metadata = { ["tree"] = Chain(1_200), ["big"] = JsonValue.Create(9_007_199_254_740_993L) } });
            Assert.True(await client.FlushAsync());
        }

        // The client's own limit (48 levels inside metadata and change values) refuses the deep event before sending.
        var sent = Assert.Single(server.Requests.SelectMany(r => r.Events));
        Assert.Equal("deep.allowed", sent.GetProperty("action").GetString());
        Assert.Contains(drops, d => d.Action == "deep.refused" && d.Reason == DropReason.Invalid);

        // The deepest request body stays far below 1,000 levels.
        var deepest = server.Requests.Max(r => Depth(r.Body));
        Assert.True(deepest < 60, "deepest body nesting: " + deepest);
    }

    private static JsonNode Chain(int depth)
    {
        JsonNode node = new JsonObject { ["leaf"] = true };
        for (var i = 0; i < depth; i++)
        {
            node = new JsonObject { ["n"] = node };
        }

        return node;
    }

    private static int Depth(byte[] body)
    {
        var reader = new Utf8JsonReader(body, new JsonReaderOptions { MaxDepth = 2_000 });
        var deepest = 0;
        while (reader.Read())
        {
            deepest = Math.Max(deepest, reader.CurrentDepth);
        }

        return deepest;
    }
}
