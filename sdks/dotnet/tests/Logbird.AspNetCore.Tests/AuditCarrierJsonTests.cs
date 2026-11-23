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
    public void Null_or_malformed_json_is_refused()
    {
        Assert.Throws<ArgumentNullException>(() => AuditCarrier.FromJson((string)null!));
        Assert.Throws<JsonException>(() => AuditCarrier.FromJson("null"));
        Assert.Throws<JsonException>(() => AuditCarrier.FromJson("[1]"));
        Assert.Throws<JsonException>(() => AuditCarrier.FromJson("null"u8));
    }

    [Fact]
    public void The_source_generated_context_is_not_public()
        => Assert.False(typeof(AuditCarrier).Assembly.GetType("Logbird.AspNetCore.AuditCarrierJsonContext")!.IsPublic);
}
