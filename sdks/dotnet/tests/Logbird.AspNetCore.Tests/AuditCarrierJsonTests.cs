using System;
using System.Text;
using System.Text.Json;
using Logbird.AspNetCore;

namespace Logbird.AspNetCore.Tests;

/// <summary>The carrier serializes through its own methods; the source-generated context behind them is internal.</summary>
public class AuditCarrierJsonTests
{
    private static readonly AuditCarrier Carrier = new()
    {
        OperationId = "op_1",
        RequestId = "req_1",
        ParentEventId = "evt_1",
        Actor = new AuditActor("user", "user_42") { Name = "Fictional" },
        Tenant = new AuditTenant("acct_7"),
    };

    [Fact]
    public void A_carrier_round_trips_as_text_and_as_utf8_bytes()
    {
        Assert.Equal(Carrier, AuditCarrier.FromJson(Carrier.ToJson()));
        Assert.Equal(Carrier, AuditCarrier.FromJson(Carrier.ToJsonUtf8Bytes()));
        Assert.Equal(Carrier.ToJson(), Encoding.UTF8.GetString(Carrier.ToJsonUtf8Bytes()));
    }

    [Fact]
    public void The_json_is_camel_case_and_leaves_absent_values_out()
    {
        var json = Carrier.ToJson();
        Assert.Contains("\"operationId\":\"op_1\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("traceId", json, StringComparison.Ordinal);
        Assert.DoesNotContain("impersonator", json, StringComparison.Ordinal);
    }

    [Fact]
    public void A_null_string_is_an_argument_error()
        => Assert.Throws<ArgumentNullException>(() => AuditCarrier.FromJson((string)null!));

    [Theory]
    [InlineData("null")]
    [InlineData("[1]")]
    [InlineData("{")]
    [InlineData("{\"operationId\":\"op_1\"")]
    [InlineData("{\"unrelated\":42}")]
    [InlineData("{\"tenant\":{\"id\":null}}")]
    [InlineData("{\"tenant\":{}}")]
    [InlineData("{\"actor\":{\"id\":\"user_42\"}}")]
    [InlineData("{\"actor\":{\"type\":\"user\"}}")]
    [InlineData("{\"impersonator\":{\"name\":\"Fictional\"}}")]
    [InlineData("{\"actor\":{\"type\":\"user\",\"id\":\"u\",\"unknown\":1}}")]
    public void Json_that_is_not_a_carrier_is_refused_as_text_and_as_bytes(string json)
    {
        Assert.Throws<JsonException>(() => AuditCarrier.FromJson(json));
        Assert.Throws<JsonException>(() => AuditCarrier.FromJson(Encoding.UTF8.GetBytes(json)));
    }

    [Fact]
    public void Text_that_cannot_be_utf8_is_a_json_error()
        => Assert.Throws<JsonException>(() => AuditCarrier.FromJson("{\"operationId\":\"op" + (char)0xD800 + "\"}"));

    [Fact]
    public void A_carrier_that_could_not_be_read_back_is_not_written()
    {
        // Built around the constructors' non-null contract, as a lenient deserializer can: refused on write, not in the worker.
        foreach (var carrier in new[]
        {
            new AuditCarrier { Tenant = new AuditTenant(null!) },
            new AuditCarrier { Actor = new AuditActor("user", null!) },
            new AuditCarrier { Actor = new AuditActor(null!, "user_42") },
            new AuditCarrier { Impersonator = new AuditImpersonator(null!) },
        })
        {
            Assert.Throws<InvalidOperationException>(() => carrier.ToJson());
            Assert.Throws<InvalidOperationException>(() => carrier.ToJsonUtf8Bytes());
        }

        // And the case found in review: a carrier read leniently from {"Tenant":{}}.
        var lenient = JsonSerializer.Deserialize<AuditCarrier>("{\"Tenant\":{}}")!;
        Assert.Throws<InvalidOperationException>(() => lenient.ToJson());
    }

    [Fact]
    public void An_empty_object_is_an_empty_carrier()
    {
        Assert.Equal(new AuditCarrier(), AuditCarrier.FromJson("{}"));
        Assert.Equal(new AuditCarrier(), AuditCarrier.FromJson("{}"u8));
    }

    [Fact]
    public void The_pascal_case_a_default_serializer_writes_is_read_too()
    {
        var pascal = "{\"OperationId\":\"op_1\",\"RequestId\":\"req_1\",\"ParentEventId\":\"evt_1\",\"Actor\":{\"Type\":\"user\",\"Id\":\"user_42\",\"Name\":\"Fictional\"},\"Tenant\":{\"Id\":\"acct_7\"}}";
        Assert.Equal(Carrier, AuditCarrier.FromJson(pascal));
    }

    [Fact]
    public void The_source_generated_context_is_not_public()
        => Assert.False(typeof(AuditCarrier).Assembly.GetType("Logbird.AspNetCore.AuditCarrierJsonContext")!.IsPublic);
}
