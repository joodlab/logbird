using System;
using System.Text;
using System.Text.Json.Nodes;
using Logbird.Internal;

namespace Logbird.Tests;

/// <summary>The size check that runs before any copy is a true lower bound of the serialized size, and stops early.</summary>
public class MeasureTests
{
    [Fact]
    public void Separators_count_so_a_shallow_array_of_numbers_over_the_limit_is_too_large()
    {
        var zeroes = new JsonArray();
        for (var i = 0; i < 150_000; i++)
        {
            zeroes.Add(0);
        }

        var e = new AuditEvent("zeroes") { Metadata = { ["zeroes"] = zeroes } };
        Assert.True(Encoding.UTF8.GetByteCount(zeroes.ToJsonString()) > LogbirdClient.MaxEventBytes);
        Assert.Equal(JsonDepth.Shape.TooLarge, JsonDepth.Measure(e, LogbirdClient.MaxEventBytes));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(7)]
    [InlineData(1000)]
    public void The_measure_never_exceeds_the_serialized_size(int items)
    {
        var tree = new JsonObject
        {
            ["numbers"] = new JsonArray(),
            ["strings"] = new JsonArray(),
            ["flags"] = new JsonObject { ["yes"] = true, ["no"] = false, ["none"] = null },
            ["nested"] = new JsonObject { ["empty"] = new JsonObject(), ["list"] = new JsonArray() },
        };
        for (var i = 0; i < items; i++)
        {
            tree["numbers"]!.AsArray().Add(i);
            tree["strings"]!.AsArray().Add("s" + i);
        }

        // Measured against the metadata object as it is serialized, the lower bound must fit within the real size, both
        // for nodes built in code and for parsed ones.
        var metadata = new JsonObject { ["t"] = tree.DeepClone() };
        var bytes = Encoding.UTF8.GetByteCount(metadata.ToJsonString());
        var built = new AuditEvent(string.Empty) { Metadata = { ["t"] = tree.DeepClone() } };
        var parsed = new AuditEvent(string.Empty) { Metadata = { ["t"] = JsonNode.Parse(tree.ToJsonString()) } };
        Assert.Equal(JsonDepth.Shape.Ok, JsonDepth.Measure(built, bytes));
        Assert.Equal(JsonDepth.Shape.Ok, JsonDepth.Measure(parsed, bytes));
    }
}
