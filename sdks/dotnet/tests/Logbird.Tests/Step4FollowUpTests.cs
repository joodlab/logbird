using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Logbird.Internal;

namespace Logbird.Tests;

/// <summary>Review of PR 1 (step-4 delivery and accounting): the fixes for R01 to R11 and the boundary checks of B01.</summary>
public class Step4FollowUpTests
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

    private static readonly JsonNodeOptions CaseInsensitive = new() { PropertyNameCaseInsensitive = true };

    // ---------------------------------------------------------------- R01: copies keep the source's options

    [Fact]
    public void Redact_finds_changes_in_a_case_insensitive_parsed_event()
    {
        var parsed = JsonNode.Parse(
            """{"action":"x","Changes":[{"field":"password","before":"old-secret","after":"new-secret"}]}""",
            CaseInsensitive)!;

        var redacted = new Redactor().Redact((JsonObject)parsed);

        var change = redacted["changes"]![0]!;
        Assert.Equal("[redacted]", change["before"]!.GetValue<string>());
        Assert.Equal("[redacted]", change["after"]!.GetValue<string>());
    }

    [Fact]
    public void A_copy_keeps_each_containers_effective_options()
    {
        var parsed = JsonNode.Parse("""{"Outer":{"Inner":[{"Key":1}]}}""", CaseInsensitive)!;
        var copy = JsonTree.Clone(parsed)!;

        Assert.NotNull(copy["outer"]?["inner"]?[0]?["key"]);
        Assert.True(copy["outer"]!.Options?.PropertyNameCaseInsensitive);
    }

    [Fact]
    public async Task A_BeforeSend_hook_removes_a_key_from_case_insensitive_metadata_by_any_casing()
    {
        var server = new FakeServer();
        await using var client = Client(Options(o => o.BeforeSend = e =>
        {
            e.Metadata.Remove("internalnote");
            return e;
        }), server);
        var metadata = (JsonObject)JsonNode.Parse("""{"InternalNote":"fictional","kept":1}""", CaseInsensitive)!;
        client.Track(new AuditEvent("x") { Metadata = metadata });
        Assert.True(await client.FlushAsync());

        var sent = Assert.Single(server.Requests.SelectMany(r => r.Events)).GetProperty("metadata");
        Assert.False(sent.TryGetProperty("InternalNote", out _));
        Assert.Equal(1, sent.GetProperty("kept").GetInt32());
    }

    // ---------------------------------------------------------------- R03: one frame per level

#if NET
    [Fact]
    public void A_wide_array_of_containers_is_measured_without_queueing_its_members()
    {
        // 200,000 one-element arrays (4 bytes each, under the guard) and 400,000 empty ones (3 bytes each, over it). Queueing
        // every member, as before, allocated megabytes; one frame per level allocates next to nothing.
        var nested = new JsonArray();
        for (var i = 0; i < 200_000; i++)
        {
            nested.Add((JsonNode)new JsonArray(0));
        }

        // System.Text.Json creates an empty array's list the first time anything reads it (whoever reads the caller's nodes
        // first pays that once, and it stays with the node); it is read here so the measurement below counts only the walk.
        var empty = new JsonArray();
        for (var i = 0; i < 400_000; i++)
        {
            var member = new JsonArray();
            _ = member.Count;
            empty.Add((JsonNode)member);
        }

        var small = new AuditEvent("nested") { Metadata = { ["n"] = nested } };
        var large = new AuditEvent("empty") { Metadata = { ["e"] = empty } };
        JsonSize.Measure(new AuditEvent("warm up") { Metadata = { ["w"] = new JsonArray(new JsonArray(0)) } }, LogbirdClient.MaxDataBytes);

        var before = GC.GetAllocatedBytesForCurrentThread();
        var smallShape = JsonSize.Measure(small, LogbirdClient.MaxDataBytes);
        var largeShape = JsonSize.Measure(large, LogbirdClient.MaxDataBytes);
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        Assert.Equal(JsonSize.Shape.Ok, smallShape);
        Assert.Equal(JsonSize.Shape.TooLarge, largeShape);
        Assert.True(allocated < 16 * 1024, allocated.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }
#endif

    // ---------------------------------------------------------------- R04: every carried field is measured

    [Fact]
    public void The_guard_measures_context_schema_version_change_framing_and_number_digits()
    {
        var over = LogbirdClient.MaxDataBytes + 1;
        Assert.Equal(JsonSize.Shape.TooLarge, JsonSize.Measure(new AuditEvent("x") { Context = new AuditContext { UserAgent = new string('u', over) } }, LogbirdClient.MaxDataBytes));
        Assert.Equal(JsonSize.Shape.TooLarge, JsonSize.Measure(new AuditEvent("x") { SchemaVersion = new string('v', over) }, LogbirdClient.MaxDataBytes));

        var digits = JsonNode.Parse("0." + new string('1', over))!;
        Assert.Equal(JsonSize.Shape.TooLarge, JsonSize.Measure(new AuditEvent("x") { Metadata = { ["n"] = digits } }, LogbirdClient.MaxDataBytes));

        var changes = new AuditEvent("x");
        for (var i = 0; i < over / JsonSize.ChangeFraming + 1; i++)
        {
            changes.Change(string.Empty, null, null);
        }

        Assert.Equal(JsonSize.Shape.TooLarge, JsonSize.Measure(changes, LogbirdClient.MaxDataBytes));
    }

    [Fact]
    public async Task A_context_over_the_guard_is_refused_before_it_is_copied()
    {
        var copies = 0;
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o =>
        {
            o.OnDrop = drops.Enqueue;
            o.BeforeSend = e =>
            {
                Interlocked.Increment(ref copies);
                return e;
            };
        }), new FakeServer());
        client.Track(new AuditEvent("x") { Context = new AuditContext { UserAgent = new string('u', 1_100_000) } });
        Assert.True(await client.FlushAsync());

        Assert.Equal(0, copies);
        var drop = Assert.Single(drops);
        Assert.Equal(DropReason.TooLarge, drop.Reason);
        Assert.Equal(LogbirdClient.GuardDetail, drop.Detail);
        Assert.False(drop.MayBeStored);
    }

    [Fact]
    public void A_parsed_strings_escapes_count_as_one_code_unit_each()
    {
        var parsed = (JsonValue)JsonNode.Parse("\"a" + (char)92 + "n" + (char)92 + "u00e9b\"")!;
        Assert.True(JsJson.TryGetStringLength(parsed, out var units));
        Assert.Equal(4, units);
        Assert.Equal(JsJson.DecodeString(parsed.ToJsonString()).Length, units);
    }

    // ---------------------------------------------------------------- R05: the writer's budget is UTF-8 bytes

    [Theory]
    [InlineData(0x0800, 250_000)]
    [InlineData(0x0001, 50_000)]
    [InlineData(0x00e9, 140_000)]
    public void The_writer_stops_at_the_UTF8_byte_limit(int character, int count)
    {
        // 250,000 three-byte characters are 750,000 bytes; 50,000 controls escape to 300,000; 140,000 two-byte characters
        // are 280,000. Each is under 262,144 UTF-16 code units.
        var node = new JsonObject { ["s"] = new string((char)character, count) };
        Assert.Null(JsJson.ToUtf8(node, LogbirdClient.MaxEventBytes));
    }

    [Fact]
    public void The_writer_counts_exactly_what_it_writes()
    {
        var text = "a" + (char)0xe9 + (char)0x800 + (char)0xD83D + (char)0xDE00 + (char)0xD800 + (char)1 + (char)34 + "z";
        var node = new JsonObject { ["k"] = text, ["n"] = JsonNode.Parse("12.50"), ["a"] = new JsonArray(true, null) };
        var full = JsJson.ToUtf8(node);

        Assert.Equal(full, JsJson.ToUtf8(node, full.Length));
        Assert.Null(JsJson.ToUtf8(node, full.Length - 1));
    }

    // ---------------------------------------------------------------- R07: a structured change field is written iteratively

    [Fact]
    public void Redact_matches_a_structured_change_field_as_deep_as_the_event_allows()
    {
        // The field sits at level 4 of the event; 1,003 levels under it make the event 1,007 deep (within 1,008), past
        // System.Text.Json's own writer limit of 1,000.
        JsonNode field = new JsonArray("password");
        for (var i = 0; i < 1_003; i++)
        {
            field = new JsonArray(field);
        }

        var eventJson = new JsonObject
        {
            ["action"] = "x",
            ["changes"] = new JsonArray(new JsonObject { ["field"] = field, ["before"] = "old-secret", ["after"] = "new-secret" }),
        };

        var redacted = new Redactor().Redact(eventJson);

        Assert.Equal("[redacted]", redacted["changes"]![0]!["after"]!.GetValue<string>());
    }

    // ---------------------------------------------------------------- R08: a notice that could not be queued is retried

    [Fact]
    public async Task A_loss_notice_the_pool_refused_is_sent_once_when_it_recovers()
    {
        var gate = new ManualResetEventSlim();
        var notices = new ConcurrentQueue<Exception>();
        var logger = new EntityIdTests.CapturingLogger();
        var client = new LogbirdClient(
            Options(o =>
            {
                o.MaxQueueSize = 1_000;
                o.OnDrop = _ => gate.Wait();
                o.OnError = e =>
                {
                    if (e.Message.Contains("logbird.notifications.lost", StringComparison.Ordinal))
                    {
                        notices.Enqueue(e);
                    }
                };
            }),
            new HttpClient(new FakeServer()),
            logger,
            delay: (_, _) => Task.CompletedTask);
        var scheduled = new List<WaitCallback>();
        var refusals = 0;
        client.ScheduleNotice = callback =>
        {
            lock (scheduled)
            {
                if (refusals < 2)
                {
                    // The first attempt is refused, the second throws: neither may use up the one notice.
                    return refusals++ == 0 ? false : throw new NotSupportedException("fictional");
                }

                scheduled.Add(callback);
                return true;
            }
        };
        await client.DisposeAsync();
        try
        {
            // The first OnDrop blocks, so the notification queue (1,000) fills and every later drop is skipped.
            for (var i = 0; i < 3_000; i++)
            {
                client.Track(new AuditEvent("after shutdown"));
            }

            Assert.Equal(2, refusals);
            var notice = Assert.Single(scheduled);
            notice(null);

            Assert.Single(notices);
            Assert.Single(logger.Lines, line => line.Contains("logbird.notifications.lost", StringComparison.Ordinal));
            Assert.True(client.NotificationsLost >= 2_000);
        }
        finally
        {
            gate.Set();
        }
    }

    // ---------------------------------------------------------------- R10: a skipped entry counts every callback it carries

    [Fact]
    public void A_skipped_entry_counts_as_many_lost_callbacks_as_it_carries()
    {
        long lost = 0;
        var notifier = new Notifier(1, count => Interlocked.Add(ref lost, count), () => { }, schedule: _ => true);
        notifier.Post(() => { });
        notifier.Post(() => { }, weight: 3);
        notifier.Post(() => { });

        Assert.Equal(4, Interlocked.Read(ref lost));
    }

    [Fact]
    public async Task Identifier_warnings_skipped_together_count_one_lost_notification_each()
    {
        // Warnings are queued for accepted events, one entry per event; the first OnError blocks the notifications.
        var errorGate = new ManualResetEventSlim();
        await using var live = Client(Options(o =>
        {
            o.MaxQueueSize = 1_000;
            o.OnError = _ => errorGate.Wait();

            // One event per batch, so every event drains whatever the sender's timing (no partial batch waits an hour).
            o.BatchSize = 1;
        }), new FakeServer());
        try
        {
            var longId = new string('a', 300);
            for (var i = 0; i < 1_100; i++)
            {
                live.Track(new AuditEvent("filler") { Actor = AuditActor.User(longId) });
            }

            // The notification queue is now full of one-warning entries behind the blocked first one; an event with two
            // warnings is skipped as one entry and counts two. The event queue is drained first, so tracking it evicts nothing.
            await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
            {
                while (live.Stats.QueueLength > 0)
                {
                    await Task.Delay(10);
                }
            });
            var before = live.NotificationsLost;
            live.Track(new AuditEvent("two warnings") { Actor = AuditActor.User(longId), Tenant = new AuditTenant(longId) });
            Assert.Equal(before + 2, live.NotificationsLost);
        }
        finally
        {
            errorGate.Set();
        }
    }

    // ---------------------------------------------------------------- R11: a batch report is reserved before settlement

    [Fact]
    public async Task A_batch_report_is_reserved_before_its_events_settle_and_posted_after()
    {
        var order = new List<string>();
        var server = new FakeServer().Then(request => FakeServer.Accept(request, (0, "invalid_event")));
        var sender = new BatchSender(
            new HttpClient(server),
            Endpoint,
            "lb_ingest_fictional",
            0,
            TimeSpan.FromSeconds(10),
            drop: (_, _, _, _) => null,
            warn: (_, _) => { },
            progress: () => { },
            report: _ => order.Add("unreserved report"),
            settle: (item, count) =>
            {
                if (!item.TrySettle())
                {
                    return false;
                }

                count();
                order.Add("settled");
                return true;
            },
            reserveReport: () =>
            {
                order.Add("reserved");
                return error => order.Add(error is null ? "released" : "posted " + error.GetType().Name);
            });
        var json = Encoding.UTF8.GetBytes("{\"id\":\"evt_1\",\"action\":\"x\",\"occurredAt\":\"2026-11-23T00:00:00.000Z\"}");
        await sender.SendAsync([new QueuedEvent(json, "evt_1", "x", 1)], CancellationToken.None);

        Assert.Equal(["reserved", "settled", "posted LogbirdRejectedException"], order);
    }

    [Fact]
    public async Task A_wait_covers_a_reserved_report_and_later_notifications_keep_their_order()
    {
        var ran = new List<string>();
        var notifier = new Notifier(10, _ => { }, () => { });
        var slot = notifier.Reserve();
        notifier.Post(() => ran.Add("later"));

        // Nothing behind the reserved place runs, and a wait does not return, until it is filled.
        var wait = notifier.WaitAsync(CancellationToken.None);
        await Task.Delay(100);
        Assert.False(wait.IsCompleted);
        Assert.Empty(ran);

        notifier.PostReserved(slot, () => ran.Add("reserved"));
        await Deadline.Within(TimeSpan.FromSeconds(10), () => wait);
        Assert.Equal(["reserved", "later"], ran);

        // A released place is skipped without running anything.
        var released = notifier.Reserve();
        notifier.Post(() => ran.Add("after release"));
        notifier.PostReserved(released, null);
        await Deadline.Within(TimeSpan.FromSeconds(10), () => notifier.WaitAsync(CancellationToken.None));
        Assert.Equal(["reserved", "later", "after release"], ran);
    }

    [Fact]
    public async Task With_only_OnError_a_flush_returns_after_the_rejection_report()
    {
        var reports = new ConcurrentQueue<Exception>();
        var server = new FakeServer().Then(request => FakeServer.Accept(request, (0, "invalid_event")));
        await using var client = Client(Options(o => o.OnError = reports.Enqueue), server);
        client.Track(new AuditEvent("x"));

        Assert.True(await client.FlushAsync());
        Assert.Single(reports.OfType<LogbirdRejectedException>());
    }

    [Fact]
    public void An_empty_root_is_checked_against_the_budget()
    {
        // "x" is 1 byte and an empty metadata object 2: 3 fits a 3-byte budget and not a 2-byte one.
        var auditEvent = new AuditEvent("x") { Metadata = new JsonObject() };
        Assert.Equal(JsonSize.Shape.Ok, JsonSize.Measure(auditEvent, 3));
        Assert.Equal(JsonSize.Shape.TooLarge, JsonSize.Measure(auditEvent, 2));
    }

    [Fact]
    public void A_copy_keeps_keys_that_differ_only_by_case_under_a_case_insensitive_parent()
    {
        // A child filled case-sensitively, then attached under a case-insensitive parent, holds "Plan" and "plan". Its
        // copy follows the rule its own dictionary follows, so both survive, through AuditEvent.Clone as well.
        var child = new JsonObject { ["Plan"] = "first", ["plan"] = "second" };
        var parent = new JsonObject(CaseInsensitive) { ["child"] = child, ["Kept"] = 1 };

        var copy = (JsonObject)JsonTree.Clone(parent)!;
        var copiedChild = (JsonObject)copy["child"]!;
        Assert.Equal(["Plan", "plan"], copiedChild.Select(p => p.Key).ToArray());
        Assert.Equal("first", copiedChild["Plan"]!.GetValue<string>());
        Assert.NotNull(copy["kept"]);

        var auditEvent = new AuditEvent("x") { Metadata = parent };
        var cloned = auditEvent.Clone();
        Assert.Equal(2, ((JsonObject)cloned.Metadata["child"]!).Count);
    }

    [Fact]
    public async Task A_value_under_many_ancestors_outside_the_event_is_refused_before_anything_reads_it()
    {
        // The value attached to the event is small, but it sits under 100,000 levels of the caller's own tree, none with
        // options. System.Text.Json would climb all of them to look options up; the depth check counts them first (Parent
        // reads only) and refuses the event as Invalid, on a 256 KB stack, before anything reads or copies the value.
        JsonNode outer = new JsonObject { ["value"] = new JsonObject { ["plan"] = "pro", ["seats"] = 3 } };
        var value = outer["value"]!;
        for (var i = 0; i < 100_000; i++)
        {
            outer = new JsonObject { ["n"] = outer };
        }

        var server = new FakeServer();
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o => o.OnDrop = drops.Enqueue), server);
        Exception? failure = null;
        var thread = new Thread(
            () =>
            {
                try
                {
                    client.Track(new AuditEvent("subtree").Change("plan", null, value));
                }
                catch (Exception e)
                {
                    failure = e;
                }
            },
            256 * 1024);
        thread.Start();
        thread.Join();
        Assert.Null(failure);
        Assert.True(await client.FlushAsync());

        Assert.Empty(server.Requests);
        var drop = Assert.Single(drops);
        Assert.Equal(DropReason.Invalid, drop.Reason);
        Assert.Equal(LogbirdClient.DepthDetail, drop.Detail);
    }

    [Fact]
    public void Parents_outside_the_event_count_toward_the_depth_limit_exactly()
    {
        // {"leaf":1} under k parents: the object is at level k + 1 and its leaf at k + 2, which may be at most 1,000.
        static JsonNode Under(int parents)
        {
            JsonNode outer = new JsonObject { ["value"] = new JsonObject { ["leaf"] = 1 } };
            var value = outer["value"]!;
            for (var i = 1; i < parents; i++)
            {
                outer = new JsonObject { ["n"] = outer };
            }

            return value;
        }

        Assert.Equal(JsonSize.Shape.Ok, JsonSize.Measure(new AuditEvent("x").Change("f", null, Under(998)), long.MaxValue));
        Assert.Equal(JsonSize.Shape.TooDeep, JsonSize.Measure(new AuditEvent("x").Change("f", null, Under(999)), long.MaxValue));
        Assert.Equal(JsonSize.Shape.Ok, JsonSize.Measure(new AuditEvent("x").Change("f", null, Under(3)), long.MaxValue));
    }

    [Fact]
    public void A_copy_keeps_a_case_insensitive_rule_when_the_first_key_is_the_Kelvin_sign()
    {
        // The Kelvin sign's lower case is a different key under the case-insensitive comparer, so it cannot tell the rule;
        // the next key does, and a hook's case-insensitive removal still works on the copy.
        var metadata = (JsonObject)JsonNode.Parse("{\"" + (char)0x212A + "\":1,\"InternalNote\":\"fictional\"}", CaseInsensitive)!;
        var copy = (JsonObject)JsonTree.Clone(metadata)!;
        Assert.True(copy.Remove("internalnote"));

        var cloned = new AuditEvent("x") { Metadata = metadata }.Clone();
        Assert.True(cloned.Metadata.Remove("internalnote"));
    }

    [Fact]
    public void A_child_whose_keys_do_not_tell_its_rule_is_copied_case_sensitive()
    {
        // An explicitly case-sensitive child holding only the Kelvin sign, under a case-insensitive parent: no key tells the
        // rule, so the copy is case-sensitive, and later writes of "Plan" and "plan" stay two fields, as on the source.
        var child = new JsonObject(new JsonNodeOptions()) { [((char)0x212A).ToString()] = 1 };
        var parent = new JsonObject(CaseInsensitive) { ["child"] = child };

        var copiedChild = (JsonObject)((JsonObject)JsonTree.Clone(parent)!)["child"]!;
        copiedChild["Plan"] = 2;
        copiedChild["plan"] = 3;
        Assert.Equal(3, copiedChild.Count);

        var cloned = new AuditEvent("x") { Metadata = parent }.Clone();
        var clonedChild = (JsonObject)cloned.Metadata["child"]!;
        clonedChild["Plan"] = 2;
        clonedChild["plan"] = 3;
        Assert.Equal(3, clonedChild.Count);

        // An undecided copy never merges, even of an explicitly case-insensitive empty child: a write keeps both keys
        // rather than overwriting one.
        var insensitive = new JsonObject(CaseInsensitive);
        var copied = (JsonObject)((JsonObject)JsonTree.Clone(new JsonObject { ["child"] = insensitive })!)["child"]!;
        copied["Plan"] = 2;
        copied["plan"] = 3;
        Assert.Equal(2, copied.Count);
    }

    [Fact]
    public void A_child_filled_while_detached_stays_case_sensitive_under_a_case_insensitive_ancestor()
    {
        // Filled with a key that has no case while detached, its dictionary is case-sensitive; attached later under a
        // case-insensitive grandparent, its Options report that grandparent's rule. The copy must not merge "Plan" and "plan".
        var child = new JsonObject { ["1"] = 1 };
        var parent = new JsonObject { ["child"] = child };
        var grandparent = new JsonObject(CaseInsensitive) { ["parent"] = parent };
        Assert.True(child.Options!.Value.PropertyNameCaseInsensitive);
        child["Plan"] = 2;
        child["plan"] = 3;
        Assert.Equal(3, child.Count);
        Assert.True(child.Remove("Plan") && child.Remove("plan"));

        var copiedChild = (JsonObject)((JsonObject)((JsonObject)JsonTree.Clone(grandparent)!)["parent"]!)["child"]!;
        copiedChild["Plan"] = 2;
        copiedChild["plan"] = 3;
        Assert.Equal(3, copiedChild.Count);

        var clonedChild = (JsonObject)((JsonObject)new AuditEvent("x") { Metadata = grandparent }.Clone().Metadata["parent"]!)["child"]!;
        clonedChild["Plan"] = 2;
        clonedChild["plan"] = 3;
        Assert.Equal(3, clonedChild.Count);
    }

    [Fact]
    public void A_copy_keeps_a_custom_converters_representation()
    {
        var options = new JsonSerializerOptions { TypeInfoResolver = new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver() };
        options.Converters.Add(new InvoiceNumberConverter());
        var typeInfo = (System.Text.Json.Serialization.Metadata.JsonTypeInfo<int>)options.GetTypeInfo(typeof(int));
        var auditEvent = new AuditEvent("x");
        auditEvent.Metadata["invoice"] = JsonValue.Create(741, typeInfo);

        Assert.Equal("\"invoice-741\"", auditEvent.Clone().Metadata["invoice"]!.ToJsonString());
        Assert.Equal("\"invoice-741\"", JsonTree.Clone(auditEvent.Metadata)!["invoice"]!.ToJsonString());
    }

    private sealed class InvoiceNumberConverter : System.Text.Json.Serialization.JsonConverter<int>
    {
        public override int Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
            => int.Parse(reader.GetString()!.Remove(0, "invoice-".Length), System.Globalization.CultureInfo.InvariantCulture);

        public override void Write(Utf8JsonWriter writer, int value, JsonSerializerOptions options)
            => writer.WriteStringValue("invoice-" + value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task A_successful_answer_reserves_no_report()
    {
        var reservations = 0;
        var server = new FakeServer().Then(request => FakeServer.Accept(request));
        var sender = new BatchSender(
            new HttpClient(server),
            Endpoint,
            "lb_ingest_fictional",
            0,
            TimeSpan.FromSeconds(10),
            drop: (_, _, _, _) => null,
            warn: (_, _) => { },
            progress: () => { },
            report: _ => { },
            reserveReport: () =>
            {
                reservations++;
                return _ => { };
            });
        var json = Encoding.UTF8.GetBytes("{\"id\":\"evt_1\",\"action\":\"x\",\"occurredAt\":\"2026-11-23T00:00:00.000Z\"}");
        await sender.SendAsync([new QueuedEvent(json, "evt_1", "x", 1)], CancellationToken.None);

        Assert.Equal(0, reservations);
    }

    [Fact]
    public async Task An_event_tracked_after_Dispose_returns_is_dropped_as_shutdown()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var client = Client(Options(o => o.OnDrop = drops.Enqueue), new FakeServer());
        client.Dispose();
        client.Track(new AuditEvent("late"));

        Assert.Equal(0, client.Stats.Tracked);
        await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
        {
            while (drops.IsEmpty)
            {
                await Task.Delay(10);
            }
        });
        Assert.Equal(DropReason.Shutdown, Assert.Single(drops).Reason);
    }

    // ---------------------------------------------------------------- R06 (maintainer ruling b): depth is checked as given

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
    public async Task Depth_is_checked_without_recursion_on_the_given_event_and_on_what_BeforeSend_returns()
    {
        // 100,000 levels on a 256 KB stack: a recursive walk would overflow and end the test host. The given event is
        // refused before anything copies it; a hook that returns a new, deeper event meets the same check before
        // redaction and serialisation walk it, with the same Invalid drop.
        var server = new FakeServer();
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o =>
        {
            o.OnDrop = drops.Enqueue;
            o.BeforeSend = e => e.Action == "hook.deepens"
                ? new AuditEvent("hook.deepens") { Id = e.Id }.Change("tree", null, Chain(100_000))
                : e;
        }), server);
        Exception? failure = null;
        var thread = new Thread(
            () =>
            {
                try
                {
                    client.Track(new AuditEvent("given.deep") { Metadata = { ["token"] = Chain(100_000) } });
                    client.Track(new AuditEvent("hook.deepens"));
                }
                catch (Exception e)
                {
                    failure = e;
                }
            },
            256 * 1024);
        thread.Start();
        thread.Join();
        Assert.Null(failure);
        Assert.True(await client.FlushAsync());

        Assert.Empty(server.Requests);
        Assert.Equal(["given.deep", "hook.deepens"], drops.Select(d => d.Action).OrderBy(a => a, StringComparer.Ordinal).ToArray());
        Assert.All(drops, d =>
        {
            Assert.Equal(DropReason.Invalid, d.Reason);
            Assert.Equal(LogbirdClient.DepthDetail, d.Detail);
        });
    }

    // ---------------------------------------------------------------- B01: the guard's boundary, on redaction-shrinkable data

    [Fact]
    public async Task Redactable_data_just_under_the_guard_is_sent_and_just_over_it_is_refused()
    {
        static AuditEvent WithToken(int length) => new("x") { Id = "evt_boundary", Metadata = { ["token"] = new string('s', length) } };

        // The longest token the guard admits, found from its own measure (the unit is documented on JsonSize).
        var length = LogbirdClient.MaxDataBytes - 64;
        while (JsonSize.Measure(WithToken(length + 1), LogbirdClient.MaxDataBytes) == JsonSize.Shape.Ok)
        {
            length++;
        }

        Assert.Equal(JsonSize.Shape.Ok, JsonSize.Measure(WithToken(length), LogbirdClient.MaxDataBytes));
        Assert.True(length > LogbirdClient.MaxDataBytes - 64);

        var server = new FakeServer();
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var client = Client(Options(o => o.OnDrop = drops.Enqueue), server);
        client.Track(WithToken(length));
        client.Track(WithToken(length + 1));
        Assert.True(await client.FlushAsync());

        var sent = Assert.Single(server.Requests.SelectMany(r => r.Events));
        Assert.Equal("[redacted]", sent.GetProperty("metadata").GetProperty("token").GetString());
        var drop = Assert.Single(drops);
        Assert.Equal(DropReason.TooLarge, drop.Reason);
        Assert.Equal(LogbirdClient.GuardDetail, drop.Detail);
    }
}
