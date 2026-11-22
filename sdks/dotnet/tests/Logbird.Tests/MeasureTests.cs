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

    [Fact]
    public void A_parsed_array_over_the_limit_is_rejected_without_building_its_children()
    {
        var text = "[" + string.Join(",", System.Linq.Enumerable.Repeat("0", 1_000_000)) + "]";
        var parsed = JsonNode.Parse(text)!;
        var e = new AuditEvent("parsed") { Metadata = { ["zeroes"] = parsed } };
#if !NETFRAMEWORK
        var before = GC.GetAllocatedBytesForCurrentThread();
#endif
        Assert.Equal(JsonDepth.Shape.TooLarge, JsonDepth.Measure(e, LogbirdClient.MaxEventBytes));
#if !NETFRAMEWORK
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;

        // Building 1,000,000 child nodes would allocate tens of megabytes; the precheck streams from the document.
        Assert.True(allocated < 2_000_000, "allocated " + allocated + " bytes");
#endif
    }

    [Fact]
    public void A_text_of_characters_the_writer_escapes_is_not_rejected_while_it_fits()
    {
        // DEL is one byte in Logbird's output but six when the writer escapes it; 200,000 of them still fit in 256 KB.
        var e = new AuditEvent("del") { Metadata = { ["text"] = new string((char)0x7F, 200_000) } };
        Assert.Equal(JsonDepth.Shape.Ok, JsonDepth.Measure(e, LogbirdClient.MaxEventBytes));
        var nested = new AuditEvent("del") { Metadata = { ["obj"] = new JsonObject { ["text"] = new string((char)0x7F, 200_000) } } };
        Assert.Equal(JsonDepth.Shape.Ok, JsonDepth.Measure(nested, LogbirdClient.MaxEventBytes));

        // A supplementary character is four bytes in Logbird's output and twelve when the writer escapes it.
        var emoji = char.ConvertFromUtf32(0x1F600);
        var text = new System.Text.StringBuilder().Insert(0, emoji, 60_000).ToString();
        var faces = new AuditEvent("emoji") { Metadata = { ["obj"] = new JsonObject { ["text"] = text } } };
        Assert.Equal(JsonDepth.Shape.Ok, JsonDepth.Measure(faces, LogbirdClient.MaxEventBytes));
    }
}
