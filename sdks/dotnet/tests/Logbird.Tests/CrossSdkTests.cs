using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>
/// The same event recorded by the TypeScript SDK (Fixtures/typescript-envelope.golden.txt, produced by
/// tests/cross-sdk/typescript-envelope.ts) and by this SDK must be byte-identical on the wire.
/// </summary>
public class CrossSdkTests
{
    private static readonly char[] LineFeed = [(char)10];

    private static string Chars(params int[] codes) => new(codes.Select(c => (char)c).ToArray());

    [Fact]
    public async Task The_wire_json_matches_the_typescript_sdk_byte_for_byte()
    {
        var expected = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "typescript-envelope.golden.txt"), Encoding.UTF8).Split(LineFeed, StringSplitOptions.RemoveEmptyEntries);
        var server = new FakeServer();
        var options = new LogbirdOptions { Endpoint = new Uri("https://audit.example.invalid"), IngestKey = "lb_ingest_fictional" };
        options.Redaction.Enabled = false; // The TypeScript SDK redacts only when asked.
        await using var client = new LogbirdClient(options, new HttpClient(server));
        client.Track(new AuditEvent("invoice.updated")
        {
            Id = "0193f2b6-6c00-7abc-8def-0123456789ab",
            OccurredAt = new DateTimeOffset(2026, 11, 22, 8, 0, 0, 123, TimeSpan.Zero),
            Environment = "staging",
            Outcome = AuditOutcome.Success,
            Severity = AuditSeverity.Notice,
            Description = "Fictional user changed INV-1 " + Chars(0x645, 0x631, 0x62D, 0x628, 0x627) + " " + Chars(0x2713)
                + " \"quoted\" " + Chars(92) + " back, tab" + Chars(9),
            Actor = AuditActor.User("user_42", "Fictional User", "fictional@example.invalid"),
            Impersonator = new AuditImpersonator("support_1") { Name = "Support" },
            Executor = AuditExecutor.Worker("billing-worker", jobId: "job_1", attempt: 2, name: "Billing worker"),
            Tenant = new AuditTenant("acct_7") { Name = "Fictional Co" },
            Source = "billing-service",
            Targets = { new AuditTarget("invoice", "inv_1") { Name = "INV-1" }, new AuditTarget("customer", "cus_9") },
            Changes =
            {
                new AuditChange("status", "draft", "sent"),
                new AuditChange("limit", 24, 48),
                AuditChange.Set("note", "new"),
                new AuditChange("flags", null, new System.Text.Json.Nodes.JsonObject { ["vip"] = true, ["tags"] = new System.Text.Json.Nodes.JsonArray("a", "b") }),
            },
            Context =
            {
                OperationId = "op_1",
                ParentEventId = "evt_parent",
                RequestId = "req_1",
                TraceId = "4bf92f3577b34da6a3ce929d0e0e4736",
                Ip = "203.0.113.9",
                UserAgent = "Fictional/1.0",
            },
            Metadata = { ["plan"] = "pro", ["seats"] = 3, ["ratio"] = 1.5, ["nested"] = new System.Text.Json.Nodes.JsonObject { ["ok"] = true, ["none"] = null } },
            SchemaVersion = "1",
        });
        client.Track(new AuditEvent("session.started")
        {
            Id = "0193f2b6-6c00-7abc-8def-0123456789ac",
            OccurredAt = new DateTimeOffset(2026, 11, 22, 8, 0, 1, TimeSpan.Zero),
        });
        client.Track(new AuditEvent("unicode.checked")
        {
            Id = "0193f2b6-6c00-7abc-8def-0123456789ad",
            OccurredAt = new DateTimeOffset(2026, 11, 22, 8, 0, 2, TimeSpan.Zero),
            Description = "emoji " + char.ConvertFromUtf32(0x1F600) + " lone " + Chars(0xD800) + " ls " + Chars(0x2028) + " del " + Chars(0x7F),
            Targets = new List<AuditTarget>(),
            Changes = new List<AuditChange>(),
            Metadata = { ["list"] = new JsonArray(1, "two", null, new JsonObject { ["deep"] = new JsonArray() }) },
        });
        client.Track(new AuditEvent("numbers.checked")
        {
            Id = "0193f2b6-6c00-7abc-8def-0123456789ae",
            OccurredAt = new DateTimeOffset(2026, 11, 22, 8, 0, 3, TimeSpan.Zero),
            Metadata =
            {
                ["10"] = "a",
                ["b"] = "x",
                ["2"] = "y",
                ["01"] = "z",
                ["ratio"] = 1.5,
                ["one"] = 1.00m,
                ["big"] = 1e21,
                ["tiny"] = 1e-7,
                ["neg0"] = -0.0,
                ["tenth"] = 0.10m,
                ["max"] = 9_007_199_254_740_991L,
                ["nan"] = double.NaN,
                ["inf"] = double.PositiveInfinity,
                ["ninf"] = double.NegativeInfinity,
                ["eps"] = double.Epsilon,
            },
        });
        Assert.True(await client.FlushAsync());

        // What a BeforeSend hook returns is sent as it is; a replacement event has no occurredAt, context or metadata.
        var replacingServer = new FakeServer();
        var replacingOptions = new LogbirdOptions
        {
            Endpoint = new Uri("https://audit.example.invalid"),
            IngestKey = "lb_ingest_fictional",
            BeforeSend = _ => new AuditEvent("replaced.by.hook") { Id = "0193f2b6-6c00-7abc-8def-0123456789af" },
        };
        replacingOptions.Redaction.Enabled = false;
        await using (var replacing = new LogbirdClient(replacingOptions, new HttpClient(replacingServer)))
        {
            replacing.Track(new AuditEvent("original.event"));
            Assert.True(await replacing.FlushAsync());
        }

        // Defaults apply before the hook; a hook that clears a default or the timestamp keeps it cleared.
        var clearingServer = new FakeServer();
        var clearingOptions = new LogbirdOptions
        {
            Endpoint = new Uri("https://audit.example.invalid"),
            IngestKey = "lb_ingest_fictional",
            Source = "default-service",
            BeforeSend = e =>
            {
                e.OccurredAt = null;
                e.Source = null;
                return e;
            },
        };
        clearingOptions.Redaction.Enabled = false;
        await using (var clearing = new LogbirdClient(clearingOptions, new HttpClient(clearingServer)))
        {
            clearing.Track(new AuditEvent("cleared.by.hook") { Id = "0193f2b6-6c00-7abc-8def-0123456789b0" });
            Assert.True(await clearing.FlushAsync());
        }

        var actual = server.Requests.Concat(replacingServer.Requests).Concat(clearingServer.Requests).SelectMany(r => r.RawEvents).ToArray();
        Assert.Equal(expected, actual);
    }
}
