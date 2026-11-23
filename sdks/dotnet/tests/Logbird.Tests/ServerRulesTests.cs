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
    private static LogbirdClient Client(FakeServer server, ConcurrentQueue<DroppedEvent>? drops = null, Action<LogbirdOptions>? configure = null)
    {
        var options = new LogbirdOptions
        {
            Endpoint = new Uri("https://audit.example.invalid"),
            IngestKey = "lb_ingest_fictional",
            FlushInterval = TimeSpan.FromHours(1),
            OnDrop = drops is null ? null : drops.Enqueue,
        };
        configure?.Invoke(options);
        return new LogbirdClient(options, new HttpClient(server));
    }

    [Fact]
    public async Task OccurredAt_is_by_default_an_ISO_8601_UTC_string_with_milliseconds()
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
    public async Task OccurredAt_is_never_sent_as_a_number_even_when_a_hook_or_redaction_changes_it()
    {
        var server = new FakeServer();
        await using (var client = Client(server, configure: o =>
        {
            // A hook may clear the timestamp (the server then stamps the event), and a host may redact the field.
            o.BeforeSend = e =>
            {
                if (e.Action == "hook.cleared")
                {
                    e.OccurredAt = null;
                }

                return e;
            };
            o.Redaction.AddKeys("occurredAt");
        }))
        {
            client.Track(new AuditEvent("hook.cleared") { OccurredAt = DateTimeOffset.UtcNow });
            client.Track(new AuditEvent("redacted") { OccurredAt = DateTimeOffset.UtcNow });
            Assert.True(await client.FlushAsync());
        }

        var events = server.Requests.SelectMany(r => r.Events).ToArray();
        Assert.Equal(2, events.Length);
        Assert.False(events[0].TryGetProperty("occurredAt", out _));
        foreach (var e in events)
        {
            Assert.False(e.TryGetProperty("occurredAt", out var at) && at.ValueKind == JsonValueKind.Number);
        }

        Assert.Equal(JsonValueKind.String, events[1].GetProperty("occurredAt").ValueKind);
    }

    [Fact]
    public void The_client_depth_limit_is_the_servers_1000_levels()
        => Assert.Equal(1_000, Logbird.Internal.JsonSize.Max);

    [Fact]
    public async Task The_depth_boundary_is_exact_for_metadata_and_change_values()
    {
        // Metadata is level 1, its "tree" member level 2, and Chain(n)'s leaf value level n + 3; a change value is itself
        // level 1, so Chain(n)'s leaf is level n + 2. A node deeper than JsonSize.Max is refused.
        var max = Logbird.Internal.JsonSize.Max;
        var metadataOk = max - 3;
        var changeOk = max - 2;
        var big = 9_007_199_254_740_993L;
        var server = new FakeServer();
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using (var client = Client(server, drops))
        {
            client.Track(new AuditEvent("metadata.last_accepted") { Metadata = { ["tree"] = Chain(metadataOk), ["big"] = JsonValue.Create(big) } });
            client.Track(new AuditEvent("metadata.first_refused") { Metadata = { ["tree"] = Chain(metadataOk + 1), ["big"] = JsonValue.Create(big) } });
            client.Track(new AuditEvent("change.last_accepted").Change("tree", Chain(changeOk), JsonValue.Create(big)));
            client.Track(new AuditEvent("change.first_refused").Change("tree", Chain(changeOk + 1), JsonValue.Create(big)));
            Assert.True(await client.FlushAsync());
        }

        var sent = server.Requests.SelectMany(r => r.Events).Select(e => e.GetProperty("action").GetString()!).OrderBy(a => a, StringComparer.Ordinal).ToArray();
        Assert.Equal(["change.last_accepted", "metadata.last_accepted"], sent);
        Assert.Equal(
            ["change.first_refused", "metadata.first_refused"],
            drops.Where(d => d.Reason == DropReason.Invalid).Select(d => d.Action).OrderBy(a => a, StringComparer.Ordinal).ToArray());

        // The accepted boundary events on the wire: the envelope adds a few levels on top of the server's 1,000.
        var deepest = server.Requests.Max(r => Depth(r.Body));
        Assert.InRange(deepest, max, max + 8);
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
        var reader = new Utf8JsonReader(body, new JsonReaderOptions { MaxDepth = 4_096 });
        var deepest = 0;
        while (reader.Read())
        {
            deepest = Math.Max(deepest, reader.CurrentDepth);
        }

        return deepest;
    }
}
