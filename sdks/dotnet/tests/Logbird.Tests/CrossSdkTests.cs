using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
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
        Assert.True(await client.FlushAsync());
        Assert.Equal(expected, server.Requests.Single().RawEvents);
    }
}
