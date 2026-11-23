using System.Collections.Generic;
using System.Text.Json.Nodes;

namespace Logbird.Internal;

/// <summary>
/// Copies caller-built JSON without recursion. <see cref="JsonNode.DeepClone"/> recurses once per level and can exhaust a
/// small stack well inside what the server accepts; this walks an explicit stack, so any depth the size limit allows is
/// copied on any thread.
/// </summary>
internal static class JsonTree
{
    // Explicit options on every copied container: a node without them looks its options up through its parents,
    // recursively, the first time it is filled, which would overflow the stack on a deep copy.
    private static readonly JsonNodeOptions Options = new() { PropertyNameCaseInsensitive = false };

    /// <summary>A deep copy of <paramref name="root"/>, with objects and arrays rebuilt iteratively.</summary>
    public static JsonNode? Clone(JsonNode? root)
    {
        var pending = new Stack<(JsonNode Source, JsonNode Copy)>();
        var copy = Shallow(root, pending);
        while (pending.Count > 0)
        {
            var (source, target) = pending.Pop();
            if (source is JsonObject sourceObject)
            {
                var targetObject = (JsonObject)target;
                foreach (var pair in sourceObject)
                {
                    targetObject[pair.Key] = Shallow(pair.Value, pending);
                }
            }
            else
            {
                var targetArray = (JsonArray)target;
                foreach (var item in (JsonArray)source)
                {
                    targetArray.Add(Shallow(item, pending));
                }
            }
        }

        return copy;
    }

    /// <summary>A copy of one node: a leaf in full, an empty container whose contents are filled from the stack.</summary>
    private static JsonNode? Shallow(JsonNode? node, Stack<(JsonNode Source, JsonNode Copy)> pending)
    {
        switch (node)
        {
            case null:
                return null;
            case JsonObject:
                var obj = new JsonObject(Options);
                pending.Push((node, obj));
                return obj;
            case JsonArray:
                var array = new JsonArray(Options);
                pending.Push((node, array));
                return array;
            default:
                // A JsonValue has no children, so its own DeepClone does not recurse.
                return node.DeepClone();
        }
    }
}
