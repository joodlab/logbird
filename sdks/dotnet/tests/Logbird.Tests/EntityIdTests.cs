using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>Entity identifiers are sent exactly as given, and the SDK refuses those Logbird would not index as given.</summary>
public class EntityIdTests
{
    private static readonly Uri Endpoint = new("https://audit.example.invalid/");

    private sealed class Harness : IAsyncDisposable
    {
        public Harness(FakeServer? server = null)
        {
            Server = server ?? new FakeServer();
            Client = new LogbirdClient(
                new LogbirdOptions
                {
                    Endpoint = Endpoint,
                    IngestKey = "lb_ingest_fictional",
                    FlushInterval = TimeSpan.FromHours(1),
                    OnError = Errors.Enqueue,
                    OnDrop = Drops.Enqueue,
                },
                new HttpClient(Server));
        }

        public FakeServer Server { get; }

        public LogbirdClient Client { get; }

        public ConcurrentQueue<Exception> Errors { get; } = new();

        public ConcurrentQueue<DroppedEvent> Drops { get; } = new();

        public ValueTask DisposeAsync() => Client.DisposeAsync();
    }

    private static string Lone(int code) => ((char)code).ToString();

    public static IEnumerable<object[]> Unstorable()
    {
        yield return [new AuditEvent("x") { Actor = AuditActor.User(new string('a', 257)) }, TooLong("actor.id", 256)];
        yield return [new AuditEvent("x") { Impersonator = new AuditImpersonator("i" + Lone(0xD800)) }, Surrogate("impersonator.id")];
        yield return [new AuditEvent("x") { Executor = AuditExecutor.Api(new string('e', 300)) }, TooLong("executor.id", 256)];
        yield return [new AuditEvent("x") { Tenant = new AuditTenant(Lone(0xDC00) + "t") }, Surrogate("tenant.id")];
        yield return [new AuditEvent("x").Target(new string('t', 65), "r1"), TooLong("targets[0].type", 64)];
        yield return [new AuditEvent("x").Target("record", "ok").Target("record", new string('r', 257)), TooLong("targets[1].id", 256)];
        var many = new AuditEvent("x");
        for (var i = 0; i < 257; i++)
        {
            many.Target("record", $"r{i}");
        }

        yield return [many, "invalid_entity_id: the event has more than 256 targets, the most this SDK sends (Logbird up to 0.2.x indexes only the first 64), so the SDK did not send the event"];
    }

    private static string TooLong(string field, int max)
        => $"invalid_entity_id: {field} is longer than {max} UTF-16 code units; Logbird would not index it as given, so the SDK did not send the event";

    private static string Surrogate(string field)
        => $"invalid_entity_id: {field} contains a lone surrogate; Logbird would not index it as given, so the SDK did not send the event";

    [Theory]
    [MemberData(nameof(Unstorable))]
    public async Task An_identifier_Logbird_would_not_index_as_given_drops_the_event_before_sending(AuditEvent auditEvent, string expected)
    {
        await using var h = new Harness();
        h.Client.Track(auditEvent);
        h.Client.Track(new AuditEvent("sibling"));
        Assert.True(await h.Client.FlushAsync());
        var drop = Assert.Single(h.Drops);
        Assert.Equal(DropReason.InvalidEntityId, drop.Reason);
        Assert.Equal(expected, drop.Detail);
        Assert.Equal("An audit event was dropped: " + expected, Assert.Single(h.Errors).Message);
        Assert.Equal(["sibling"], h.Server.Requests.SelectMany(r => r.Events).Select(e => e.GetProperty("action").GetString()));
        Assert.Equal(1, h.Client.Stats.Dropped);
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
        var warning = Assert.Single(h.Errors.OfType<LogbirdEventWarning>());
        Assert.Equal(
            "surrounding whitespace in targets[64].id: sent exactly as given; Logbird up to 0.2.x indexes only the first 64 targets, so this one is kept in the stored payload only",
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
