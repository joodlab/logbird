using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;

namespace Logbird.Internal;

/// <summary>
/// Copies caller-built JSON without recursion. <see cref="JsonNode.DeepClone"/> recurses once per level and can exhaust a
/// small stack well inside what the server accepts; this walks an explicit stack, so any depth the size limit allows is
/// copied on any thread.
/// </summary>
/// <remarks>
/// Each copied object gets the case rule its source dictionary actually follows, read from the dictionary itself (not from
/// inherited options, which can differ for an object filled before it was attached), and every copied container gets
/// explicit options, so filling the copy never looks options up through its own parents. Leaves are copied with their own
/// <see cref="JsonNode.DeepClone"/>, which keeps a custom converter's representation; System.Text.Json looks their
/// options up through the source's parents, which <see cref="JsonSize"/> has counted, outside parents included, before
/// anything copies the event.
/// </remarks>
internal static class JsonTree
{
    /// <summary>A deep copy of <paramref name="root"/>, with objects and arrays rebuilt iteratively.</summary>
    public static JsonNode? Clone(JsonNode? root)
    {
        if (root is null)
        {
            return null;
        }

        // A root with no parent holds its own options, so reading them cannot climb.
        var rootOptions = root.Parent is null ? root.Options ?? default : default;
        var pending = new Stack<(JsonNode Source, JsonNode Copy, JsonNodeOptions Options)>();
        var copy = Shallow(root, rootOptions, pending);
        while (pending.Count > 0)
        {
            var (source, target, options) = pending.Pop();
            if (source is JsonObject sourceObject)
            {
                var targetObject = (JsonObject)target;
                foreach (var pair in sourceObject)
                {
                    targetObject.Add(pair.Key, Shallow(pair.Value, options, pending));
                }
            }
            else
            {
                var targetArray = (JsonArray)target;
                foreach (var item in (JsonArray)source)
                {
                    targetArray.Add(Shallow(item, options, pending));
                }
            }
        }

        return copy;
    }

    /// <summary>A copy of one node: a leaf in full, an empty container whose contents are filled from the stack.</summary>
    private static JsonNode? Shallow(JsonNode? node, JsonNodeOptions inherited, Stack<(JsonNode Source, JsonNode Copy, JsonNodeOptions Options)> pending)
    {
        switch (node)
        {
            case null:
                return null;
            case JsonObject source:
                var options = CaseRule(source, inherited);
                var obj = new JsonObject(options);
                pending.Push((node, obj, options));
                return obj;
            case JsonArray:
                var array = new JsonArray(inherited);
                pending.Push((node, array, inherited));
                return array;
            default:
                return node.DeepClone();
        }
    }

    /// <summary>
    /// The options for an object's copy: <paramref name="inherited"/>, with the case rule the source's dictionary actually
    /// follows when its keys reveal it. A key with a case variant tells: the variant is found without being a key only in a
    /// case-insensitive dictionary. An object filled case-sensitively and later attached under a case-insensitive parent
    /// can hold both "Plan" and "plan"; it stays case-sensitive, so the copy keeps both.
    /// </summary>
    private static JsonNodeOptions CaseRule(JsonObject source, JsonNodeOptions inherited)
    {
        foreach (var pair in source)
        {
            var key = pair.Key;
            // Only a variant the case-insensitive comparer itself treats as the same key can tell (the Kelvin sign's
            // lower case, for one, is a different key under it).
            var variant = key.ToUpperInvariant();
            if (string.Equals(variant, key, StringComparison.Ordinal) || !string.Equals(variant, key, StringComparison.OrdinalIgnoreCase))
            {
                variant = key.ToLowerInvariant();
                if (string.Equals(variant, key, StringComparison.Ordinal) || !string.Equals(variant, key, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
            }

            var insensitive = source.ContainsKey(variant) && !HasKey(source, variant);
            var options = inherited;
            options.PropertyNameCaseInsensitive = insensitive;
            return options;
        }

        // No key tells (empty, or no letters): the rule the copy would have inherited.
        return inherited;
    }

    private static bool HasKey(JsonObject source, string key)
    {
        foreach (var pair in source)
        {
            if (string.Equals(pair.Key, key, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }
}
