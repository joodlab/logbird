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
    /// <summary>
    /// A deep copy of <paramref name="root"/>, with objects and arrays rebuilt iteratively. Each copied container gets its
    /// source's effective options (a case-insensitive object stays case-insensitive), set explicitly: a node without them
    /// looks its options up through its parents, recursively, which would overflow the stack on a deep copy.
    /// </summary>
    public static JsonNode? Clone(JsonNode? root)
    {
        if (root is null)
        {
            return null;
        }

        Resolve(root);
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

    /// <summary>
    /// Resolves the options of <paramref name="node"/> and its ancestors from the top down. A node caches the options it
    /// inherits once looked up, so resolving each level after its parent never recurses more than one level, however deep
    /// the node sits in the caller's tree.
    /// </summary>
    private static void Resolve(JsonNode node)
    {
        var chain = new Stack<JsonNode>();
        for (var current = node; current is not null; current = current.Parent)
        {
            chain.Push(current);
        }

        while (chain.Count > 0)
        {
            _ = chain.Pop().Options;
        }
    }

    /// <summary>A copy of one node: a leaf in full, an empty container whose contents are filled from the stack.</summary>
    private static JsonNode? Shallow(JsonNode? node, Stack<(JsonNode Source, JsonNode Copy)> pending)
    {
        switch (node)
        {
            case null:
                return null;
            case JsonObject:
                // The source's parent was resolved before it (the root's chain by Resolve, the others as they were
                // copied), so this lookup reads at most one cached level.
                var obj = new JsonObject(node.Options ?? default);
                pending.Push((node, obj));
                return obj;
            case JsonArray:
                var array = new JsonArray(node.Options ?? default);
                pending.Push((node, array));
                return array;
            default:
                // A JsonValue has no children, so its own DeepClone does not recurse.
                return node.DeepClone();
        }
    }
}
