using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>Entity identifiers are sent exactly as given and validated with the server's rule before sending.</summary>
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
        yield return [new AuditEvent("x") { Actor = AuditActor.User(new string('a', 257)) }, "actor.id"];
        yield return [new AuditEvent("x") { Impersonator = new AuditImpersonator("i" + Lone(0xD800)) }, "impersonator.id"];
        yield return [new AuditEvent("x") { Executor = AuditExecutor.Api(new string('e', 300)) }, "executor.id"];
        yield return [new AuditEvent("x") { Tenant = new AuditTenant(Lone(0xDC00) + "t") }, "tenant.id"];
        yield return [new AuditEvent("x").Target(new string('t', 65), "r1"), "targets[0].type"];
        yield return [new AuditEvent("x").Target("record", "ok").Target("record", new string('r', 257)), "targets[1].id"];
        var many = new AuditEvent("x");
        for (var i = 0; i < 257; i++)
        {
            many.Target("record", $"r{i}");
        }

        yield return [many, "more than 256 targets"];
    }

    [Theory]
    [MemberData(nameof(Unstorable))]
    public async Task An_identifier_the_server_cannot_store_drops_the_event_before_sending(AuditEvent auditEvent, string expected)
    {
        await using var h = new Harness();
        h.Client.Track(auditEvent);
        h.Client.Track(new AuditEvent("sibling"));
        Assert.True(await h.Client.FlushAsync());
        var drop = Assert.Single(h.Drops);
        Assert.Equal(DropReason.InvalidEntityId, drop.Reason);
        Assert.StartsWith("invalid_entity_id: ", drop.Detail);
        Assert.Contains(expected, drop.Detail);
        Assert.EndsWith("so the event was not sent", drop.Detail);
        Assert.DoesNotContain("same rule", drop.Detail);
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
        var warnings = h.Errors.OfType<LogbirdEventWarning>().Select(w => w.Reason).ToArray();
        Assert.Equal(
            new[] { "actor.id", "tenant.id", "targets[0].type" }.Select(field => "surrounding whitespace in " + field + ": sent exactly as given; Logbird servers up to 0.2.x index it trimmed, so a search for the padded id does not find it"),
            warnings);
        Assert.Equal(3, h.Client.Stats.Warnings);
        Assert.Empty(h.Drops);
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
