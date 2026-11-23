using System;
using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Xunit.Abstractions;

namespace Logbird.IntegrationTests;

/// <summary>
/// Redaction parity against a real Logbird: a pattern matching every party key keeps the parties' identifier fields
/// (an executor's attempt stays a number, so the server accepts the event) and redacts the rest, in what the server
/// stores, from either SDK. The TypeScript event comes from tests/cross-sdk/send-redacted-event.ts
/// (LOGBIRD_IT_TS_REDACTED_ID); without it only the .NET side is checked.
/// </summary>
public class RedactionLiveTests(ITestOutputHelper output)
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
    public async Task Both_sdks_store_the_same_parties_when_a_pattern_matches_every_party_key()
    {
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

        var typescriptId = Environment.GetEnvironmentVariable("LOGBIRD_IT_TS_REDACTED_ID");
        if (string.IsNullOrEmpty(typescriptId))
        {
            output.WriteLine("LOGBIRD_IT_TS_REDACTED_ID not set: the TypeScript event was not checked");
            return;
        }

        AssertParties("typescript", await LiveServer.WaitForEventAsync(reader, typescriptId));
        output.WriteLine("both SDKs' events stored the same parties: identifier fields kept, every other party field redacted, attempt a number");
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
