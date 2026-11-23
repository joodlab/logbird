using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Logbird.Tests;

/// <summary>
/// Entity identifiers are sent exactly as given, and the server decides: the SDK never refuses an event for one. It warns
/// about a property a server may index differently (surrounding whitespace, a long id, a lone surrogate, more targets than
/// Logbird up to 0.2.x indexes), and a server rejection is reported as the drop with the server's code.
/// </summary>
public class EntityIdTests
{
    private static readonly Uri Endpoint = new("https://audit.example.invalid/");

    private sealed class Harness : IAsyncDisposable
    {
        public Harness(FakeServer? server = null, Action<LogbirdOptions>? configure = null)
        {
            Server = server ?? new FakeServer();
            var options = new LogbirdOptions
            {
                Endpoint = Endpoint,
                IngestKey = "lb_ingest_fictional",
                FlushInterval = TimeSpan.FromHours(1),
                OnError = Errors.Enqueue,
                OnDrop = Drops.Enqueue,
            };
            configure?.Invoke(options);
            Client = new LogbirdClient(options, new HttpClient(Server), Logger);
        }

        public FakeServer Server { get; }

        public CapturingLogger Logger { get; } = new();

        public LogbirdClient Client { get; }

        public ConcurrentQueue<Exception> Errors { get; } = new();

        public ConcurrentQueue<DroppedEvent> Drops { get; } = new();

        public ValueTask DisposeAsync() => Client.DisposeAsync();
    }

    private static string Lone(int code) => ((char)code).ToString();

    private const string LaterServer = "; a server that rejects such an identifier rejects the event, and the SDK reports that rejection as the drop with the server's code";

    private const string LaterServerTargets = "; a server that rejects more targets than it indexes rejects the event, and the SDK reports that rejection as the drop with the server's code";

    public static IEnumerable<object[]> IndexedDifferently()
    {
        yield return [new AuditEvent("x") { Actor = AuditActor.User(new string('a', 257)) }, TooLong("actor.id", 256)];
        yield return [new AuditEvent("x") { Impersonator = new AuditImpersonator("i" + Lone(0xD800)) }, Surrogate("impersonator.id")];
        yield return [new AuditEvent("x") { Executor = AuditExecutor.Api(new string('e', 300)) }, TooLong("executor.id", 256)];
        yield return [new AuditEvent("x") { Tenant = new AuditTenant(Lone(0xDC00) + "t") }, Surrogate("tenant.id")];
        yield return [new AuditEvent("x").Target(new string('t', 65), "r1"), TooLong("targets[0].type", 64)];
        yield return [new AuditEvent("x").Target("record", "ok").Target("record", new string('r', 257)), TooLong("targets[1].id", 256)];
        var many = new AuditEvent("x");
        for (var i = 0; i < 65; i++)
        {
            many.Target("record", $"r{i}");
        }

        yield return [many, "the event has 65 targets: all are sent; Logbird up to 0.2.x stores them all but indexes only the first 64, so the others are in the stored payload only" + LaterServerTargets];
    }

    private static string TooLong(string field, int max)
        => $"{field} is longer than {max} UTF-16 code units once trimmed: sent exactly as given; Logbird up to 0.2.x stores it as sent but indexes it cut to at most {max} (never splitting a surrogate pair), so search and entity pages show the shortened value" + LaterServer;

    private static string Surrogate(string field)
        => $"{field} contains a lone surrogate: sent exactly as given; Logbird up to 0.2.x stores it as sent but indexes it with U+FFFD in place of each lone surrogate (before the length cut)" + LaterServer;

    private static string PayloadOnly(string subject)
        => subject + ": sent exactly as given; Logbird up to 0.2.x indexes only the first 64 targets, so this one is kept in the stored payload only" + LaterServer;

    internal sealed class CapturingLogger : ILogger
    {
        public ConcurrentQueue<string> Lines { get; } = new();

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            => Lines.Enqueue(formatter(state, exception));
    }

    [Theory]
    [MemberData(nameof(IndexedDifferently))]
    public async Task An_identifier_a_server_may_index_differently_is_sent_exactly_and_reported_as_a_warning(AuditEvent auditEvent, string expected)
    {
        await using var h = new Harness();
        h.Client.Track(auditEvent);
        h.Client.Track(new AuditEvent("sibling"));
        Assert.True(await h.Client.FlushAsync());
        Assert.Empty(h.Drops);
        Assert.Equal(["x", "sibling"], h.Server.Requests.SelectMany(r => r.Events).Select(e => e.GetProperty("action").GetString()));
        var warning = Assert.Single(h.Errors.OfType<LogbirdEventWarning>());
        Assert.Equal(h.Server.Requests.SelectMany(r => r.Ids).First(), warning.EventId);
        Assert.Equal(expected, warning.Reason);
        Assert.Equal("Logbird warning about an event it is sending: " + expected, warning.Message);
        Assert.Equal(new LogbirdStats(2, 2, 0, 0, 0, 0, 0, Warnings: 1), h.Client.Stats);

        // The logger gets the same message, which names the field and never carries the value.
        Assert.Contains("Logbird: Logbird warning about an event it is sending: " + expected, h.Logger.Lines);
        Assert.All(h.Logger.Lines, line => Assert.DoesNotContain("aaaaaaaaaa", line, StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_field_with_several_properties_gets_one_warning_naming_them_all()
    {
        await using var h = new Harness();
        var e = new AuditEvent("x") { Actor = AuditActor.User(" " + new string('a', 300) + Lone(0xD800) + " ") };
        for (var i = 0; i < 64; i++)
        {
            e.Target("record", "r" + i);
        }

        e.Target("record", " " + new string('r', 300) + Lone(0xDC00));
        h.Client.Track(e);
        Assert.True(await h.Client.FlushAsync());
        Assert.Equal(
            [
                "actor.id has surrounding whitespace, is longer than 256 UTF-16 code units once trimmed and contains a lone surrogate: sent exactly as given; Logbird up to 0.2.x stores it as sent but indexes it trimmed, then with U+FFFD in place of each lone surrogate, then cut to at most 256 (never splitting a surrogate pair), so search and entity pages show a different value" + LaterServer,
                "targets[64].id has surrounding whitespace, is longer than 256 UTF-16 code units once trimmed and contains a lone surrogate: sent exactly as given; Logbird up to 0.2.x indexes only the first 64 targets, so this one is kept in the stored payload only" + LaterServer,
                "the event has 65 targets: all are sent; Logbird up to 0.2.x stores them all but indexes only the first 64, so the others are in the stored payload only" + LaterServerTargets,
            ],
            h.Errors.OfType<LogbirdEventWarning>().Select(w => w.Reason));
        Assert.Equal(3, h.Client.Stats.Warnings);
    }

    [Fact]
    public async Task The_length_that_counts_is_the_trimmed_one()
    {
        // 256 code units plus surrounding whitespace: the server trims first, so it indexes all 256 and only the whitespace
        // is worth a warning.
        await using var h = new Harness();
        h.Client.Track(new AuditEvent("x") { Actor = AuditActor.User(" " + new string('a', 256) + " ") });
        Assert.True(await h.Client.FlushAsync());
        var warning = Assert.Single(h.Errors.OfType<LogbirdEventWarning>());
        Assert.StartsWith("surrounding whitespace in actor.id:", warning.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_target_past_the_64th_gets_its_own_warnings_too()
    {
        await using var h = new Harness();
        var e = new AuditEvent("x");
        for (var i = 0; i < 64; i++)
        {
            e.Target("record", "r" + i);
        }

        e.Target(new string('t', 65), "r" + Lone(0xD800));
        h.Client.Track(e);
        Assert.True(await h.Client.FlushAsync());
        Assert.Equal(
            [
                PayloadOnly("targets[64].type is longer than 64 UTF-16 code units once trimmed"),
                PayloadOnly("targets[64].id contains a lone surrogate"),
                "the event has 65 targets: all are sent; Logbird up to 0.2.x stores them all but indexes only the first 64, so the others are in the stored payload only" + LaterServerTargets,
            ],
            h.Errors.OfType<LogbirdEventWarning>().Select(w => w.Reason));
        Assert.Equal(65, h.Server.Requests.Single().Events.Single().GetProperty("targets").GetArrayLength());
    }

    [Fact]
    public async Task An_event_replaced_by_BeforeSend_is_inspected_and_sent_exactly()
    {
        var longId = new string('b', 300);
        await using var h = new Harness(configure: o => o.BeforeSend = e => new AuditEvent("replaced") { Id = e.Id, Actor = AuditActor.User(longId) });
        h.Client.Track(new AuditEvent("original") { Actor = AuditActor.User("user_ok") });
        Assert.True(await h.Client.FlushAsync());
        var sent = h.Server.Requests.Single().Events.Single();
        Assert.Equal("replaced", sent.GetProperty("action").GetString());
        Assert.Equal(longId, sent.GetProperty("actor").GetProperty("id").GetString());
        Assert.Equal([TooLong("actor.id", 256)], h.Errors.OfType<LogbirdEventWarning>().Select(w => w.Reason));
        Assert.Contains("Logbird: Logbird warning about an event it is sending: " + TooLong("actor.id", 256), h.Logger.Lines);
    }

    [Fact]
    public async Task All_warnings_about_one_event_arrive_even_when_there_are_more_than_the_notification_queue_holds()
    {
        // 1,500 padded target ids on one event, more than the 1,000-notification queue: they travel as one notification, so
        // none is lost and the flush returns after all of them ran.
        await using var h = new Harness(configure: o => o.MaxQueueSize = 1);
        var e = new AuditEvent("x");
        for (var i = 0; i < 1500; i++)
        {
            e.Target("record", " r" + i);
        }

        h.Client.Track(e);
        Assert.True(await h.Client.FlushAsync());
        Assert.Equal(1501, h.Errors.OfType<LogbirdEventWarning>().Count());
        Assert.Equal(1501, h.Client.Stats.Warnings);
        Assert.Equal(0, h.Client.NotificationsLost);
        Assert.Equal(1501, h.Logger.Lines.Count(line => line.StartsWith("Logbird: Logbird warning about an event it is sending:", StringComparison.Ordinal)));
    }

    public static IEnumerable<object[]> HugeIdentity()
    {
        var huge = new string('h', 300_000);
        yield return [new AuditEvent("x") { Impersonator = new AuditImpersonator(huge) }];
        yield return [new AuditEvent("x") { Actor = new AuditActor(huge, "u1") }];
        yield return [new AuditEvent("x") { Executor = new AuditExecutor(huge) }];
        yield return [new AuditEvent("x") { Executor = new AuditExecutor("job") { JobId = huge } }];
    }

    [Theory]
    [MemberData(nameof(HugeIdentity))]
    public async Task An_identity_field_over_256_KB_is_measured_before_it_is_copied(AuditEvent auditEvent)
    {
        // Ids over the indexed length are sent, but one that alone exceeds the event limit is refused as too large before
        // anything serializes it, like any other oversized field.
        await using var h = new Harness();
        h.Client.Track(auditEvent);
        Assert.True(await h.Client.FlushAsync());
        var drop = Assert.Single(h.Drops);
        Assert.Equal(DropReason.TooLarge, drop.Reason);
        Assert.True(drop.Json.IsEmpty);
        Assert.Empty(h.Errors.OfType<LogbirdEventWarning>());
        Assert.Empty(h.Server.Requests);
    }

    [Fact]
    public async Task A_long_list_of_empty_targets_is_measured_before_it_is_copied()
    {
        // 14,000 empty targets carry no text but at least 19 bytes of JSON each: over 256 KB, refused before serializing.
        await using var h = new Harness();
        var e = new AuditEvent("x");
        for (var i = 0; i < 14_000; i++)
        {
            e.Target(string.Empty, string.Empty);
        }

        h.Client.Track(e);
        Assert.True(await h.Client.FlushAsync());
        var drop = Assert.Single(h.Drops);
        Assert.Equal(DropReason.TooLarge, drop.Reason);
        Assert.Null(drop.Code);
        Assert.True(drop.Json.IsEmpty);
        Assert.Empty(h.Server.Requests);
    }

    [Fact]
    public async Task Identifiers_reach_the_server_exactly_as_given()
    {
        await using var h = new Harness();
        var longId = new string('a', 300);
        var lone = "user" + Lone(0xD800) + "x";
        var e = new AuditEvent("exact") { Actor = AuditActor.User(longId), Tenant = new AuditTenant(lone) };
        for (var i = 0; i < 300; i++)
        {
            e.Target("record", $"r{i}");
        }

        h.Client.Track(e);
        Assert.True(await h.Client.FlushAsync());
        var sent = h.Server.Requests.Single().Events.Single();
        Assert.Equal(longId, sent.GetProperty("actor").GetProperty("id").GetString());
        Assert.Equal(300, sent.GetProperty("targets").GetArrayLength());

        // The lone surrogate goes out escaped, exactly like JSON.stringify, so the server parses the same string.
        Assert.Contains("\\ud800", System.Text.Encoding.UTF8.GetString(h.Server.Requests.Single().Body), StringComparison.Ordinal);
        Assert.Empty(h.Drops);
        Assert.Equal(1, h.Client.Stats.Delivered);
    }

    [Fact]
    public async Task A_server_rejection_of_an_identifier_is_the_drop_with_the_servers_code()
    {
        var server = new FakeServer().Then(request => FakeServer.Json(
            HttpStatusCode.Accepted,
            JsonSerializer.Serialize(new
            {
                accepted = 1,
                ids = new[] { request.Ids[1] },
                rejected = new[] { new { index = 0, code = "invalid_entity_id", reason = "actor.id: longer than 256 characters" } },
                warnings = Array.Empty<object>(),
            })));
        await using var h = new Harness(server);
        h.Client.Track(new AuditEvent("x") { Actor = AuditActor.User(new string('a', 300)) });
        h.Client.Track(new AuditEvent("sibling"));
        Assert.True(await h.Client.FlushAsync());
        var drop = Assert.Single(h.Drops);
        Assert.Equal(DropReason.Rejected, drop.Reason);
        Assert.Equal("invalid_entity_id", drop.Code);
        Assert.Equal("actor.id: longer than 256 characters", drop.Detail);
        Assert.Equal(["invalid_entity_id"], h.Errors.OfType<LogbirdRejectedException>().Single().Codes);
        Assert.Equal(new LogbirdStats(2, 1, 1, 0, 0, 0, 0, Warnings: 1), h.Client.Stats);
    }

    [Fact]
    public async Task Identifiers_at_the_limits_and_empty_identifiers_are_sent()
    {
        await using var h = new Harness();
        var e = new AuditEvent("limits")
        {
            Actor = AuditActor.User(new string('a', 256)),
            Tenant = new AuditTenant(string.Empty),
            Executor = AuditExecutor.Api("api-" + char.ConvertFromUtf32(0x1F600)),
        };
        e.Target(new string('t', 64), new string('r', 256));
        h.Client.Track(e);
        Assert.True(await h.Client.FlushAsync());
        Assert.Empty(h.Drops);
        Assert.Empty(h.Errors.OfType<LogbirdEventWarning>());
        Assert.Equal(0, h.Client.Stats.Warnings);
        Assert.Equal(1, h.Client.Stats.Delivered);
    }

    [Fact]
    public async Task Surrounding_whitespace_is_kept_exactly_and_reported_as_a_warning()
    {
        await using var h = new Harness();
        h.Client.Track(new AuditEvent("spaced") { Actor = AuditActor.User(" user_42 "), Tenant = new AuditTenant("acct_7\t") }.Target("invoice ", "inv_1"));
        Assert.True(await h.Client.FlushAsync());
        var sent = h.Server.Requests.Single().Events.Single();
        Assert.Equal(" user_42 ", sent.GetProperty("actor").GetProperty("id").GetString());
        Assert.Equal("acct_7\t", sent.GetProperty("tenant").GetProperty("id").GetString());
        Assert.Equal("invoice ", sent.GetProperty("targets")[0].GetProperty("type").GetString());
        var warnings = h.Errors.OfType<LogbirdEventWarning>().ToArray();
        var expected = new[] { "actor.id", "tenant.id", "targets[0].type" }
            .Select(field => "surrounding whitespace in " + field + ": sent exactly as given; Logbird up to 0.2.x indexes it trimmed, so a search for the value with its whitespace does not find it")
            .ToArray();
        Assert.Equal(expected, warnings.Select(w => w.Reason));

        // The logged message names the field and the caveat too, and says the event is being sent (not stored).
        Assert.All(warnings, w => Assert.DoesNotContain("user_42", w.Message, StringComparison.Ordinal));
        Assert.Equal(expected.Select(r => "Logbird warning about an event it is sending: " + r), warnings.Select(w => w.Message));
        Assert.Equal(3, h.Client.Stats.Warnings);
        Assert.Empty(h.Drops);
    }

    [Fact]
    public async Task Whitespace_on_a_target_Logbird_does_not_index_says_so()
    {
        await using var h = new Harness();
        var e = new AuditEvent("many");
        for (var i = 0; i < 64; i++)
        {
            e.Target("record", "r" + i);
        }

        e.Target("record", " r64");
        h.Client.Track(e);
        Assert.True(await h.Client.FlushAsync());
        // Two warnings: this target's whitespace, and the event-wide one for targets past the 64th.
        var reasons = h.Errors.OfType<LogbirdEventWarning>().Select(w => w.Reason).ToArray();
        Assert.Equal(
            [
                "surrounding whitespace in targets[64].id: sent exactly as given; Logbird up to 0.2.x indexes only the first 64 targets, so this one is kept in the stored payload only",
                "the event has 65 targets: all are sent; Logbird up to 0.2.x stores them all but indexes only the first 64, so the others are in the stored payload only" + LaterServerTargets,
            ],
            reasons);
    }

    [Fact]
    public async Task Target_positions_in_messages_count_targets_as_sent()
    {
        // A null target is not serialized, so the padded target below is sent (and indexed) at position 63.
        await using var h = new Harness();
        var e = new AuditEvent("many");
        e.Targets.Add(null!);
        for (var i = 0; i < 63; i++)
        {
            e.Target("record", "r" + i);
        }

        e.Target("record", " r63");
        h.Client.Track(e);
        Assert.True(await h.Client.FlushAsync());
        Assert.Equal(64, h.Server.Requests.Single().Events.Single().GetProperty("targets").GetArrayLength());
        var warning = Assert.Single(h.Errors.OfType<LogbirdEventWarning>());
        Assert.Equal(
            "surrounding whitespace in targets[63].id: sent exactly as given; Logbird up to 0.2.x indexes it trimmed, so a search for the value with its whitespace does not find it",
            warning.Reason);
    }

    [Fact]
    public async Task Server_warnings_reach_the_caller()
    {
        var server = new FakeServer().Then(request =>
        {
            var ids = request.Ids;
            var body = new
            {
                accepted = 2,
                ids,
                rejected = Array.Empty<object>(),
                warnings = new[] { new { index = 1, reason = "occurredAt: fictional timestamp outside the window; stored at receive time" } },
            };
            return FakeServer.Json(HttpStatusCode.Accepted, JsonSerializer.Serialize(body));
        });
        await using var h = new Harness(server);
        h.Client.Track(new AuditEvent("first"));
        h.Client.Track(new AuditEvent("second"));
        Assert.True(await h.Client.FlushAsync());
        var warning = Assert.Single(h.Errors.OfType<LogbirdEventWarning>());
        Assert.Equal("second", warning.Action);
        Assert.Equal(server.Requests.Single().Ids[1], warning.EventId);
        Assert.StartsWith("occurredAt:", warning.Reason);
        Assert.Equal(new LogbirdStats(2, 2, 0, 0, 0, 0, 0, Warnings: 1), h.Client.Stats);
    }
}
