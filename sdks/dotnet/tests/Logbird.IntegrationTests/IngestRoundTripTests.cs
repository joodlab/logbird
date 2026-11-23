using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Xunit.Abstractions;

namespace Logbird.IntegrationTests;

public class IngestRoundTripTests(ITestOutputHelper output)
{
    [LiveFact]
    public async Task Events_sent_from_csharp_read_back_field_by_field()
    {
        var operation = "op_" + Guid.NewGuid().ToString("N");
        var parent = LogbirdClient.NewEventId();
        var sent = new AuditEvent("invoice.updated")
        {
            Outcome = AuditOutcome.Success,
            Severity = AuditSeverity.Notice,
            Description = "Fictional User changed the status of INV-1001",
            Actor = AuditActor.User("user_42", "Fictional User", "fictional.user@example.invalid"),
            Impersonator = new AuditImpersonator("support_7") { Name = "Fictional Support" },
            Executor = AuditExecutor.Worker("billing-worker", jobId: "job_99", attempt: 2, name: "Billing worker"),
            Tenant = new AuditTenant("acct_7") { Name = "Fictional Co" },
            Targets = { new AuditTarget("invoice", "inv_1001") { Name = "INV-1001" }, new AuditTarget("customer", "cus_9") },
            Changes = { new AuditChange("status", "draft", "sent"), new AuditChange("limit", 24, 48), AuditChange.Secret("password") },
            Context = { OperationId = operation, ParentEventId = parent, RequestId = "req_1", TraceId = "4bf92f3577b34da6a3ce929d0e0e4736", Ip = "203.0.113.9", UserAgent = "Fictional/1.0" },
            Metadata = { ["plan"] = "pro", ["seats"] = 3, ["apiToken"] = "must-not-be-stored" },
            OccurredAt = DateTimeOffset.UtcNow.AddSeconds(-5),
            Id = LogbirdClient.NewEventId(),
        };

        var errors = new ConcurrentQueue<Exception>();
        await using (var client = new LogbirdClient(LiveServer.Options(o => o.OnError = errors.Enqueue)))
        {
            client.Track(sent);
            Assert.True(await client.FlushAsync());
            Assert.Equal(1, client.Stats.Delivered);
        }

        Assert.Empty(errors);
        using var reader = LiveServer.Reader();
        var detail = await LiveServer.WaitForEventAsync(reader, sent.Id!);
        var e = detail.Event;
        Assert.Equal(sent.Id, e.Id);
        Assert.Equal("invoice.updated", e.Action);
        Assert.Equal("invoice", e.Category);
        Assert.Equal("integration", e.Environment);
        Assert.Equal("dotnet-sdk-tests", e.Source);
        Assert.Equal("success", e.Outcome);
        Assert.Equal("notice", e.Severity);
        Assert.Equal(sent.Description, e.Description);
        Assert.Equal(sent.Actor, e.Actor);
        Assert.Equal(sent.Impersonator, e.Impersonator);
        Assert.Equal(sent.Executor, e.Executor);
        Assert.Equal(sent.Tenant, e.Tenant);
        Assert.Equal([new AuditTarget("invoice", "inv_1001") { Name = "INV-1001" }, new AuditTarget("customer", "cus_9") { Name = string.Empty }], e.Targets);
        Assert.Equal([new StoredChange("status", "draft", "sent"), new StoredChange("limit", "24", "48"), new StoredChange("password", "[redacted]", "[redacted]")], e.Changes);
        Assert.Equal(operation, e.Context.OperationId);
        Assert.Equal(parent, e.Context.ParentEventId);
        Assert.Equal("req_1", e.Context.RequestId);
        Assert.Equal("4bf92f3577b34da6a3ce929d0e0e4736", e.Context.TraceId);
        Assert.Equal("203.0.113.9", e.Context.Ip);
        Assert.Equal("Fictional/1.0", e.Context.UserAgent);
        Assert.Equal("pro", e.Attributes["metadata.plan"]);
        Assert.Equal("3", e.Attributes["metadata.seats"]);
        Assert.Equal("[redacted]", e.Attributes["metadata.apiToken"]);
        Assert.Equal(sent.OccurredAt!.Value.ToUnixTimeMilliseconds(), e.Timestamp.ToUnixTimeMilliseconds());
        Assert.StartsWith("dotnet/", e.Sdk);
        Assert.Equal("[redacted]", detail.Payload.GetProperty("metadata").GetProperty("apiToken").GetString());
        Assert.DoesNotContain("must-not-be-stored", detail.Payload.GetRawText());
        output.WriteLine($"read back {e.Id}: conformance {e.Conformance}, sdk {e.Sdk}");
    }

    [LiveFact]
    public async Task A_retry_after_a_forced_503_does_not_duplicate()
    {
        var operation = "op_" + Guid.NewGuid().ToString("N");
        var handler = new FailAfterForwardingHandler(failures: 2);
        var submitted = Enumerable.Range(0, 20).Select(_ => LogbirdClient.NewEventId()).ToArray();
        await using (var client = new LogbirdClient(LiveServer.Options(), new HttpClient(handler)))
        {
            for (var i = 0; i < 20; i++)
            {
                client.Track(new AuditEvent("retry.checked") { Id = submitted[i], Context = { OperationId = operation } }.Target("record", $"rec_{i}"));
            }

            Assert.True(await client.FlushAsync());
            Assert.Equal(20, client.Stats.Delivered);
        }

        Assert.Equal(3, handler.Forwarded);
        using var reader = LiveServer.Reader();
        var count = await LiveServer.CountAsync(reader, $"operation:\"{operation}\"", 20);
        await Task.Delay(2000);
        count = await LiveServer.CountAsync(reader, $"operation:\"{operation}\"", 20);
        output.WriteLine($"server accepted the batch {handler.Forwarded} times (other responses passed through: {handler.OtherResponses}); stored {count} events");
        Assert.Equal(20, count);

        // Exactly the submitted events, each once: a duplicate cannot hide behind a missing event.
        var stored = new List<string>();
        await foreach (var e in reader.SearchAllAsync(new EventSearch { Query = $"operation:\"{operation}\"", Limit = 200, From = DateTimeOffset.UtcNow.AddHours(-1) }))
        {
            stored.Add(e.Id);
        }

        Assert.Equal(submitted.OrderBy(id => id, StringComparer.Ordinal), stored.OrderBy(id => id, StringComparer.Ordinal));
    }

    [LiveFact]
    public async Task Shutdown_flush_loses_nothing()
    {
        var operation = "op_" + Guid.NewGuid().ToString("N");
        // Defaults suit a local server; against production use a small, slow run (for example 300 events in batches of 5)
        // to stay inside its rate limits.
        var total = int.TryParse(Environment.GetEnvironmentVariable("LOGBIRD_IT_SHUTDOWN_EVENTS"), out var events) ? events : 2_500;
        var batch = int.TryParse(Environment.GetEnvironmentVariable("LOGBIRD_IT_SHUTDOWN_BATCH"), out var size) ? size : 100;
        var client = new LogbirdClient(LiveServer.Options(o =>
        {
            o.FlushInterval = TimeSpan.FromMinutes(10);
            o.ShutdownTimeout = TimeSpan.FromSeconds(60);
            o.BatchSize = batch;
            o.MaxQueueSize = Math.Max(total, 1);
        }));
        for (var i = 0; i < total; i++)
        {
            client.Track(new AuditEvent("shutdown.checked") { Context = { OperationId = operation } }.Target("record", $"rec_{i}"));
        }

        var watch = Stopwatch.StartNew();
        await client.DisposeAsync();
        output.WriteLine($"dispose sent the queue in {watch.ElapsedMilliseconds} ms: {client.Stats}");
        Assert.Equal(total, client.Stats.Delivered);
        Assert.Equal(0, client.Stats.Dropped);
        using var reader = LiveServer.Reader();
        Assert.Equal(total, await LiveServer.CountAsync(reader, $"operation:\"{operation}\"", total));
    }

    [LiveFact]
    public async Task A_rejected_event_does_not_block_its_batch()
    {
        var operation = "op_" + Guid.NewGuid().ToString("N");
        var conflictId = LogbirdClient.NewEventId();
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using (var client = new LogbirdClient(LiveServer.Options(o => o.OnDrop = drops.Enqueue)))
        {
            client.Track(new AuditEvent("rejection.original") { Id = conflictId, Context = { OperationId = operation } });
            Assert.True(await client.FlushAsync());

            client.Track(new AuditEvent("rejection.sibling") { Context = { OperationId = operation } }.Target("record", "before"));
            client.Track(new AuditEvent("rejection.bad-id") { Id = new string('x', 300), Context = { OperationId = operation } });
            client.Track(new AuditEvent("rejection.conflict") { Id = conflictId, Context = { OperationId = operation } });
            client.Track(new AuditEvent("rejection.sibling") { Context = { OperationId = operation } }.Target("record", "after"));
            Assert.True(await client.FlushAsync());
            Assert.Equal(new LogbirdStats(5, 3, 2, 0, 0, 0, 0), client.Stats);
        }

        Assert.Equal(["rejection.bad-id", "rejection.conflict"], drops.Select(d => d.Action).OrderBy(a => a, StringComparer.Ordinal));
        Assert.All(drops, d => Assert.Equal(DropReason.Rejected, d.Reason));
        Assert.Contains(drops, d => d.Detail!.StartsWith("duplicate_id_conflict", StringComparison.Ordinal));

        // The server's own code reaches the drop.
        Assert.Contains(drops, d => d.Action == "rejection.conflict" && d.Code == "duplicate_id_conflict");
        Assert.Contains(drops, d => d.Action == "rejection.bad-id" && d.Code == "invalid_event_id");
        using var reader = LiveServer.Reader();
        Assert.Equal(3, await LiveServer.CountAsync(reader, $"operation:\"{operation}\"", 3));
        Assert.Equal("rejection.original", (await LiveServer.WaitForEventAsync(reader, conflictId)).Event.Action);
        foreach (var drop in drops)
        {
            output.WriteLine($"{drop.Action}: code {drop.Code}; {drop.Detail}");
        }
    }

    [LiveFact]
    public async Task Record_trails_match_a_target_type_and_id_together_for_any_text()
    {
        // record:<type>:<id> exists from 0.2.0 (#182), and the read client refuses to send a record trail to an older server.
        var version = await LiveServer.ServerVersionAsync();
        if (version < new Version(0, 2, 0))
        {
            output.WriteLine($"server {version}: record trails need 0.2.0; skipped");
            return;
        }

        var run = Guid.NewGuid().ToString("N").Substring(0, 8);
        var bs = '\\';
        var cases = new (string Type, string Id)[]
        {
            ("invoice", "inv" + (char)9 + run + (char)10 + "line"),
            ("quote" + (char)34 + "type", "a " + (char)34 + "quoted" + (char)34 + " " + run),
            ("back" + bs + "slash", "c:" + bs + "path" + bs + run),
            ("ns:kind", "x:y:" + run),
            ("star*", "prefix" + run + "*"),
            ("請求書", "番号-" + run + " ✓"),
        };
        var expected = new Dictionary<(string Type, string Id), string>();
        var crossed = new Dictionary<(string Type, string Id), string>();
        await using (var client = new LogbirdClient(LiveServer.Options()))
        {
            foreach (var (type, id) in cases)
            {
                var match = LogbirdClient.NewEventId();
                expected[(type, id)] = match;
                client.Track(new AuditEvent("record.checked") { Id = match }.Target(type, id));

                // The same id under another type, and the same type with a longer id: a record trail matches neither.
                client.Track(new AuditEvent("record.decoy").Target("decoy", id));
                client.Track(new AuditEvent("record.decoy").Target(type, id + "-other"));

                // One event with both halves on different targets: a server matching type and id separately would return it.
                var cross = LogbirdClient.NewEventId();
                crossed[(type, id)] = cross;
                client.Track(new AuditEvent("record.cross_decoy") { Id = cross }.Target(type, id + "-other").Target("decoy", id));
            }

            Assert.True(await client.FlushAsync());
            Assert.Equal(cases.Length * 4, client.Stats.Delivered);
        }

        using var reader = LiveServer.Reader();
        foreach (var (type, id) in cases)
        {
            await LiveServer.WaitForEventAsync(reader, expected[(type, id)]);
            var crossedEvent = (await LiveServer.WaitForEventAsync(reader, crossed[(type, id)])).Event;
            Assert.Equal(2, crossedEvent.Targets.Count);
            var found = new List<string>();
            var deadline = DateTime.UtcNow.AddSeconds(30);
            do
            {
                found.Clear();
                await foreach (var e in reader.SearchAllAsync(EventSearch.ForTrail(targetId: id, targetType: type, from: DateTimeOffset.UtcNow.AddHours(-1))))
                {
                    found.Add(e.Id);
                }
            }
            while (found.Count == 0 && DateTime.UtcNow < deadline && await Delay());

            Assert.Equal([expected[(type, id)]], found);
        }

        output.WriteLine($"server {version}: {cases.Length} record trails matched exactly; same-id, longer-id and crossed decoys excluded");

        static async Task<bool> Delay()
        {
            await Task.Delay(250);
            return true;
        }
    }

    [LiveFact]
    public async Task Large_integers_and_decimals_round_trip_with_exact_digits()
    {
        // Servers before 0.2.0 round integers above 2^53 in the stored payload and attributes (issue #168, fixed by #184).
        // The bytes this SDK sends are exact (see RobustnessTests). The server-side checks run on 0.2.0 and later, or with
        // LOGBIRD_IT_EXACT_NUMBERS=1 against a server built from master before its version moves.
        var version = await LiveServer.ServerVersionAsync();
        var serverKeepsDigits = version >= new Version(0, 2, 0) || Environment.GetEnvironmentVariable("LOGBIRD_IT_EXACT_NUMBERS") == "1";
        var id = LogbirdClient.NewEventId();
        await using (var client = new LogbirdClient(LiveServer.Options()))
        {
            client.Track(new AuditEvent("ledger.posted")
            {
                Id = id,
                Metadata = { ["snowflake"] = 1_234_567_890_123_456_789L, ["amount"] = 12345678901234.567890123456m },
            });
            Assert.True(await client.FlushAsync());
        }

        using var reader = LiveServer.Reader();
        var detail = await LiveServer.WaitForEventAsync(reader, id);
        var raw = detail.Payload.GetProperty("metadata");
        output.WriteLine($"server {version}: payload snowflake={raw.GetProperty("snowflake").GetRawText()} amount={raw.GetProperty("amount").GetRawText()}; "
            + $"attributes snowflake={detail.Event.Attributes["metadata.snowflake"]} amount={detail.Event.Attributes["metadata.amount"]}");
        if (!serverKeepsDigits)
        {
            output.WriteLine("server-side digit checks skipped: they need 0.2.0 (the exact-number fix); set LOGBIRD_IT_EXACT_NUMBERS=1 against a server from master");
            return;
        }

        Assert.Equal("1234567890123456789", raw.GetProperty("snowflake").GetRawText());
        Assert.Equal("12345678901234.567890123456", raw.GetProperty("amount").GetRawText());
        Assert.Equal("1234567890123456789", detail.Event.Attributes["metadata.snowflake"]);
        Assert.Equal("12345678901234.567890123456", detail.Event.Attributes["metadata.amount"]);
    }

    [LiveFact]
    public async Task Identifiers_are_sent_exactly_and_the_server_decides()
    {
        // Every kind of identifier the SDK used to refuse, plus surrounding whitespace. The SDK sends each exactly as given
        // and warns; the server stores it (Logbird up to 0.2.x, indexing a repaired copy) or rejects it (a server with the
        // exact-identifier rule), and a rejection is the drop with the server's code. Nothing is refused by the SDK.
        var backslash = ((char)92).ToString();
        var lone = "user" + ((char)0xD800).ToString() + "x";
        var kinds = new (string Kind, AuditEvent Event, string Field)[]
        {
            ("whitespace", new AuditEvent("identity.whitespace") { Actor = AuditActor.User(" user_42 ") }, "actor.id"),
            ("long-actor", new AuditEvent("identity.long-actor") { Actor = AuditActor.User(new string('u', 300)) }, "actor.id"),
            ("long-tenant", new AuditEvent("identity.long-tenant") { Tenant = new AuditTenant(new string('t', 257)) }, "tenant.id"),
            ("long-target-type", new AuditEvent("identity.long-target-type").Target(new string('y', 65), "r1"), "targets[0].type"),
            ("long-target-id", new AuditEvent("identity.long-target-id").Target("record", new string('z', 257)), "targets[0].id"),
            ("lone-surrogate", new AuditEvent("identity.lone-surrogate") { Actor = AuditActor.User(lone) }, "actor.id"),
            ("targets-300", Many(300), "300 targets"),
        };
        var warnings = new ConcurrentQueue<LogbirdEventWarning>();
        var drops = new ConcurrentQueue<DroppedEvent>();
        var ids = new Dictionary<string, string>();
        await using (var client = new LogbirdClient(LiveServer.Options(o =>
        {
            o.OnError = e =>
            {
                if (e is LogbirdEventWarning warning)
                {
                    warnings.Enqueue(warning);
                }
            };
            o.OnDrop = drops.Enqueue;
        })))
        {
            foreach (var (kind, auditEvent, _) in kinds)
            {
                auditEvent.Id = LogbirdClient.NewEventId();
                ids[kind] = auditEvent.Id;
                client.Track(auditEvent);
            }

            Assert.True(await client.FlushAsync());
        }

        var version = await LiveServer.ServerVersionAsync();
        output.WriteLine($"server {version}");

        // The SDK refused nothing: any drop is the server's own rejection, with its code.
        Assert.All(drops, d => Assert.Equal(DropReason.Rejected, d.Reason));
        using var reader = LiveServer.Reader();
        foreach (var (kind, auditEvent, field) in kinds)
        {
            var id = ids[kind];
            var warned = warnings.Where(w => w.EventId == id).Select(w => w.Reason).ToArray();
            Assert.Contains(warned, r => r.Contains(kind == "targets-300" ? "the event has 300 targets" : field, StringComparison.Ordinal));
            var rejected = drops.FirstOrDefault(d => d.Id == id);
            if (rejected is not null)
            {
                output.WriteLine($"{kind}: rejected by the server, code {rejected.Code}; SDK warning: {warned[0]}");
                continue;
            }

            var stored = await LiveServer.WaitForEventAsync(reader, id);
            var payload = stored.Payload;
            string sent;
            string indexed;
            switch (kind)
            {
                case "long-tenant":
                    sent = Describe(payload.GetProperty("tenant").GetProperty("id").GetString());
                    indexed = Describe(stored.Event.Tenant?.Id);
                    Assert.Equal(auditEvent.Tenant!.Id, payload.GetProperty("tenant").GetProperty("id").GetString());
                    break;
                case "long-target-type":
                    sent = Describe(payload.GetProperty("targets")[0].GetProperty("type").GetString());
                    indexed = Describe(stored.Event.Targets.Count > 0 ? stored.Event.Targets[0].Type : null);
                    Assert.Equal(auditEvent.Targets[0].Type, payload.GetProperty("targets")[0].GetProperty("type").GetString());
                    break;
                case "long-target-id":
                    sent = Describe(payload.GetProperty("targets")[0].GetProperty("id").GetString());
                    indexed = Describe(stored.Event.Targets.Count > 0 ? stored.Event.Targets[0].Id : null);
                    Assert.Equal(auditEvent.Targets[0].Id, payload.GetProperty("targets")[0].GetProperty("id").GetString());
                    break;
                case "targets-300":
                    sent = payload.GetProperty("targets").GetArrayLength() + " targets";
                    indexed = stored.Event.Targets.Count + " targets";
                    Assert.Equal(300, payload.GetProperty("targets").GetArrayLength());
                    break;
                case "lone-surrogate":
                    // The payload keeps the lone surrogate: JSON.stringify writes it as an escape.
                    sent = payload.GetProperty("actor").GetProperty("id").GetRawText();
                    indexed = Describe(stored.Event.Actor?.Id);
                    Assert.Equal("\"user" + backslash + "ud800x\"", sent);
                    break;
                default:
                    sent = Describe(payload.GetProperty("actor").GetProperty("id").GetString());
                    indexed = Describe(stored.Event.Actor?.Id);
                    Assert.Equal(auditEvent.Actor!.Id, payload.GetProperty("actor").GetProperty("id").GetString());
                    break;
            }

            output.WriteLine($"{kind}: stored; payload {sent}; indexed {indexed}; SDK warning: {warned[0]}");
        }

        // Opt-in until the server's exact-identifier rule ships: Logbird up to 0.2.x indexes the id trimmed (issue #269).
        if (Environment.GetEnvironmentVariable("LOGBIRD_IT_ENTITY_IDS") == "1")
        {
            var stored = await LiveServer.WaitForEventAsync(reader, ids["whitespace"]);
            Assert.Equal(" user_42 ", stored.Event.Actor?.Id);
        }

        static AuditEvent Many(int count)
        {
            var e = new AuditEvent("identity.targets-300");
            for (var i = 0; i < count; i++)
            {
                e.Target("record", "r" + i.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }

            return e;
        }

        static string Describe(string? value)
            => value is null ? "(none)"
                : value.Length > 24 ? $"{value.Length} code units, starting \"{value.Substring(0, 8)}\""
                : "\"" + value.Replace(((char)0xFFFD).ToString(), "U+FFFD", StringComparison.Ordinal) + "\"";
    }

    [LiveFact(requires: "LOGBIRD_IT_LOAD")]
    public async Task Load_50000_events()
    {
        const int total = 50_000;
        var operation = "op_" + Guid.NewGuid().ToString("N");
        GC.Collect();
        var before = GC.GetTotalMemory(forceFullCollection: true);
        var process = Process.GetCurrentProcess();
        var client = new LogbirdClient(LiveServer.Options(o =>
        {
            o.MaxQueueSize = total;
            o.BatchSize = 500;
        }));
        var watch = Stopwatch.StartNew();
        var trackWatch = Stopwatch.StartNew();
        for (var i = 0; i < total; i++)
        {
            client.Track(new AuditEvent("load.checked")
            {
                Actor = AuditActor.User($"user_{i % 100}"),
                Tenant = new AuditTenant($"acct_{i % 10}"),
                Context = { OperationId = operation },
                Metadata = { ["n"] = i },
            }.Target("record", $"rec_{i}").Change("status", "draft", "sent"));
        }

        trackWatch.Stop();
        var peakManaged = GC.GetTotalMemory(forceFullCollection: false);
        Assert.True(await client.FlushAsync(TimeSpan.FromMinutes(5)));
        watch.Stop();
        process.Refresh();
        var stats = client.Stats;
        await client.DisposeAsync();
        output.WriteLine($"tracked {total} events in {trackWatch.ElapsedMilliseconds} ms ({total / trackWatch.Elapsed.TotalSeconds:N0} events/s on the calling thread, {trackWatch.Elapsed.TotalMilliseconds * 1000 / total:N1} us per Track)");
        output.WriteLine($"delivered all in {watch.ElapsedMilliseconds} ms ({total / watch.Elapsed.TotalSeconds:N0} events/s end to end)");
        output.WriteLine($"managed heap: {before / 1048576.0:N1} MB before, {peakManaged / 1048576.0:N1} MB with the queue full; peak working set {process.PeakWorkingSet64 / 1048576.0:N1} MB");
        output.WriteLine(stats.ToString());
        Assert.Equal(total, stats.Delivered);
        using var reader = LiveServer.Reader();
        var stored = await LiveServer.CountAsync(reader, $"operation:\"{operation}\"", total);
        output.WriteLine($"stored events read back for the operation (paged): {stored}");
        Assert.Equal(total, stored);
    }
}

public class CrossSdkReplayTests(ITestOutputHelper output)
{
    /// <summary>
    /// An event first sent by the TypeScript SDK (tests/cross-sdk/send-typescript-event.ts) and replayed from C# with the
    /// same id, action and timestamp must be an exact retry, not a duplicate_id_conflict.
    /// </summary>
    [LiveFact(requires: "LOGBIRD_IT_TS_EVENT")]
    public async Task Replaying_a_typescript_event_from_csharp_is_an_exact_retry()
    {
        var id = Environment.GetEnvironmentVariable("LOGBIRD_IT_TS_EVENT_ID")!;
        var at = DateTimeOffset.Parse(Environment.GetEnvironmentVariable("LOGBIRD_IT_TS_EVENT_AT")!, System.Globalization.CultureInfo.InvariantCulture);
        using var reader = LiveServer.Reader();

        // The stored event must come from the TypeScript SDK, so the replay below cannot pass as a fresh insert.
        var original = await LiveServer.WaitForEventAsync(reader, id);
        Assert.StartsWith("typescript/", original.Event.Sdk);
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using (var client = new LogbirdClient(new LogbirdOptions
        {
            Endpoint = new Uri(LiveServer.Endpoint!),
            IngestKey = LiveServer.IngestKey,
            OnDrop = drops.Enqueue,
        }))
        {
            client.Track(new AuditEvent("cross.sdk.replayed") { Id = id, OccurredAt = at });
            Assert.True(await client.FlushAsync());
            output.WriteLine($"replayed {id} from C#: {client.Stats}");
            Assert.Equal(1, client.Stats.Delivered);
        }

        Assert.Empty(drops);
        Assert.Equal(1, await LiveServer.CountAsync(reader, $"id:\"{id}\"", 1));
        var after = await LiveServer.WaitForEventAsync(reader, id);
        Assert.StartsWith("typescript/", after.Event.Sdk);
        Assert.Equal(original.Event.ReceivedAt, after.Event.ReceivedAt);
    }
}
