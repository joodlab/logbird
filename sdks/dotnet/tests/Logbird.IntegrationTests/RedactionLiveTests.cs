using System;
using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Logbird.IntegrationTests;

/// <summary>
/// Redaction parity against a real Logbird: a pattern matching every party key keeps the parties' identifier fields
/// (an executor's attempt stays a number, so the server accepts the event) and redacts the rest, in what the server
/// stores, from either SDK. The TypeScript event comes from tests/cross-sdk/send-redacted-event.ts
/// (LOGBIRD_IT_TS_REDACTED_ID, with LOGBIRD_IT_TS_REDACTED=1).
/// </summary>
public class RedactionLiveTests
{
    private static readonly string[] Parties = ["actor", "impersonator", "executor", "tenant", "targets"];

    private static readonly JsonObject Expected = JsonNode.Parse("""
        {
          "actor": { "type": "user", "id": "user_redaction_1", "name": "[redacted]", "email": "[redacted]" },
          "impersonator": { "id": "support_redaction_1", "name": "[redacted]" },
          "executor": { "type": "worker", "id": "redaction-worker", "name": "[redacted]", "jobId": "job_redaction_1", "attempt": 3 },
          "tenant": { "id": "acct_redaction_1", "name": "[redacted]" },
          "targets": [{ "type": "invoice", "id": "inv_redaction_1", "name": "[redacted]" }]
        }
        """)!.AsObject();

    [LiveFact]
    public async Task A_dotnet_event_whose_every_party_key_matches_keeps_identities_and_is_stored()
    {
        // The same parties as tests/cross-sdk/send-redacted-event.ts sends from TypeScript (fictional values only).
        var sent = new AuditEvent("redaction.parity_checked")
        {
            Id = LogbirdClient.NewEventId(),
            Actor = AuditActor.User("user_redaction_1", "Fictional User", "fictional.user@example.invalid"),
            Impersonator = new AuditImpersonator("support_redaction_1") { Name = "Fictional Support" },
            Executor = AuditExecutor.Worker("redaction-worker", jobId: "job_redaction_1", attempt: 3, name: "Redaction worker"),
            Tenant = new AuditTenant("acct_redaction_1") { Name = "Fictional Co" },
            Targets = { new AuditTarget("invoice", "inv_redaction_1") { Name = "INV-REDACT-1" } },
        };
        var errors = new ConcurrentQueue<Exception>();
        await using (var client = new LogbirdClient(LiveServer.Options(o =>
        {
            o.OnError = errors.Enqueue;
            o.Redaction.Keys = new Regex("actor|impersonator|executor|tenant|targets", RegexOptions.CultureInvariant);
        })))
        {
            client.Track(sent);
            Assert.True(await client.FlushAsync());
            Assert.Equal(1, client.Stats.Delivered);
        }

        Assert.Empty(errors);
        using var reader = LiveServer.Reader();
        AssertParties("dotnet", await LiveServer.WaitForEventAsync(reader, sent.Id!));
    }

    [LiveFact(requires: "LOGBIRD_IT_TS_REDACTED")]
    public async Task A_typescript_event_with_the_same_pattern_stores_the_same_parties()
    {
        var id = Environment.GetEnvironmentVariable("LOGBIRD_IT_TS_REDACTED_ID");
        Assert.False(string.IsNullOrEmpty(id), "Run tests/cross-sdk/send-redacted-event.ts and set LOGBIRD_IT_TS_REDACTED_ID to the id it prints.");
        using var reader = LiveServer.Reader();
        AssertParties("typescript", await LiveServer.WaitForEventAsync(reader, id!));
    }

    private static void AssertParties(string sdk, EventDetail detail)
    {
        var payload = JsonNode.Parse(detail.Payload.GetRawText())!.AsObject();
        foreach (var party in Parties)
        {
            Assert.True(JsonNode.DeepEquals(Expected[party], payload[party]), sdk + " " + party + ": " + payload[party]?.ToJsonString());
        }

        // The stored, normalized event agrees: identities are kept.
        Assert.Equal("user_redaction_1", detail.Event.Actor!.Id);
        Assert.Equal(3, detail.Event.Executor!.Attempt);
        Assert.Equal("inv_redaction_1", detail.Event.Targets[0].Id);
    }
}
