using System;
using System.Collections.Concurrent;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Logbird.Tests;

public class RedactionPathTests
{
    [Theory]
    [InlineData("")]
    [InlineData(".private")]
    [InlineData("private.")]
    [InlineData("private..value")]
    [InlineData("private.**")]
    [InlineData("private.pre*")]
    [InlineData(@"private.\q")]
    [InlineData(@"private.\")]
    [InlineData(null)]
    public void Invalid_paths_are_refused_during_client_construction(string? path)
    {
        foreach (var keep in new[] { false, true })
        {
            var options = Options();
            if (keep)
            {
                options.Redaction.KeepPaths("metadata.valid", path!);
            }
            else
            {
                options.Redaction.AddPaths("metadata.valid", path!);
            }

            var name = keep ? nameof(RedactionOptions.KeepPaths) : nameof(RedactionOptions.AddPaths);
            var error = Assert.Throws<ArgumentException>(() => new LogbirdClient(options));
            Assert.Equal($"Invalid redaction {name} entry at index 1.", error.Message);
        }
    }

    [Fact]
    public async Task The_client_applies_path_rules_after_the_hook_and_before_the_size_limit()
    {
        var errors = new ConcurrentQueue<Exception>();
        var options = Options();
        options.OnError = errors.Enqueue;
        options.BeforeSend = evt =>
        {
            evt.Metadata["hookOnly"] = new string('x', 300 * 1024);
            return evt;
        };
        options.Redaction
            .AddKeys("email", "phone", "name")
            .AddPaths("metadata.hookOnly", "metadata.guest.contact", "targets.*.name")
            .KeepPaths("actor.name", "actor.email", "impersonator.name", "changes.*.after");
        using var server = new FakeServer();
        using var transport = new HttpClient(server);
        await using var client = new LogbirdClient(options, transport);
        client.Track(new AuditEvent("guest.changed")
        {
            Actor = AuditActor.User("staff", "Operator", "staff@example.invalid"),
            Impersonator = new AuditImpersonator("support") { Name = "Support" },
            Targets = { new AuditTarget("record", "guest") { Name = "Guest" } },
            Metadata = JsonNode.Parse("""{"token":"synthetic","guest":{"email":"guest@example.invalid","contact":"synthetic"}}""")!.AsObject(),
            Changes = { AuditChange.Set("guest.phone", "555-0100") },
        });

        Assert.True(await client.FlushAsync());
        Assert.Empty(errors);
        Assert.Equal(1, client.Stats.Delivered);
        var wire = JsonNode.Parse(Assert.Single(Assert.Single(server.Requests).RawEvents))!;
        Assert.Equal("Operator", (string?)wire["actor"]!["name"]);
        Assert.Equal("staff@example.invalid", (string?)wire["actor"]!["email"]);
        Assert.Equal("Support", (string?)wire["impersonator"]!["name"]);
        Assert.Equal("guest", (string?)wire["targets"]![0]!["id"]);
        Assert.Equal("[redacted]", (string?)wire["targets"]![0]!["name"]);
        Assert.Equal("[redacted]", (string?)wire["metadata"]!["token"]);
        Assert.Equal("[redacted]", (string?)wire["metadata"]!["hookOnly"]);
        Assert.Equal("[redacted]", (string?)wire["metadata"]!["guest"]!["contact"]);
        Assert.Equal("[redacted]", (string?)wire["metadata"]!["guest"]!["email"]);
        Assert.Equal("guest.phone", (string?)wire["changes"]![0]!["field"]);
        Assert.Equal("[redacted]", (string?)wire["changes"]![0]!["after"]);
    }

    [Fact]
    public void The_public_helper_matches_caller_built_fields_that_serialize_as_strings()
    {
        var input = new JsonObject
        {
            ["changes"] = new JsonArray(
                new JsonObject { ["field"] = JsonValue.Create('x'), ["after"] = "fictional" },
                new JsonObject { ["field"] = JsonValue.Create(Guid.Empty), ["after"] = "fictional" },
                new JsonObject { ["field"] = 7, ["after"] = "kept" }),
        };
        var redactor = new Redactor(changeFields: new Regex("^(x|00000000-0000-0000-0000-000000000000|7)$", RegexOptions.CultureInvariant));
        var result = redactor.Redact(input);
        var expected = JsonNode.Parse("""
            {"changes":[{"field":"x","after":"[redacted]"},{"field":"00000000-0000-0000-0000-000000000000","after":"[redacted]"},{"field":7,"after":"kept"}]}
            """);
        Assert.True(JsonNode.DeepEquals(expected, JsonNode.Parse(result.ToJsonString())));
    }

    [Fact]
    public async Task Reports_identifier_matches_once_and_leaves_the_identifiers_on_the_wire()
    {
        var errors = new ConcurrentQueue<Exception>();
        var options = Options();
        options.OnError = errors.Enqueue;
        options.Redaction.Keys = new Regex("^type$", RegexOptions.CultureInvariant);
        options.Redaction.AddPaths("id", "action", "*.id", "targets.0.type", "targets.*.id");
        using var server = new FakeServer();
        using var transport = new HttpClient(server);
        await using var client = new LogbirdClient(options, transport);
        client.Track(new AuditEvent("guest.changed")
        {
            Id = "event",
            Actor = AuditActor.User("staff"),
            Targets = { new AuditTarget("record", "guest") },
        });

        Assert.True(await client.FlushAsync());
        var warning = Assert.Single(errors).Message;
        Assert.Contains("identifier field(s)", warning, StringComparison.Ordinal);
        Assert.Contains("actor.id", warning, StringComparison.Ordinal);
        Assert.Contains("targets[].type", warning, StringComparison.Ordinal);
        var wire = JsonNode.Parse(Assert.Single(Assert.Single(server.Requests).RawEvents))!;
        Assert.Equal("event", (string?)wire["id"]);
        Assert.Equal("guest.changed", (string?)wire["action"]);
        Assert.Equal("staff", (string?)wire["actor"]!["id"]);
        Assert.Equal("record", (string?)wire["targets"]![0]!["type"]);
        Assert.Equal("guest", (string?)wire["targets"]![0]!["id"]);
    }

    private static LogbirdOptions Options() => new()
    {
        Endpoint = new Uri("https://logbird.example.invalid"),
        IngestKey = "fictional",
    };
}
