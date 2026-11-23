using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Logbird.Internal;

/// <summary>
/// Copies caller-built JSON without recursion. <see cref="JsonNode.DeepClone"/> recurses once per level and can exhaust a
/// small stack well inside what the server accepts; this walks an explicit stack, so any depth the size limit allows is
/// copied on any thread.
/// </summary>
/// <remarks>
/// It never asks a source node for its <see cref="JsonNode.Options"/> (except a root with no parent): a node without its own
/// options looks them up through its parents, recursively and without caching when none has any, and those parents can
/// lie outside the event, beyond any limit the SDK checks. Instead, each copied object gets the case rule its source
/// dictionary actually follows, read from the dictionary itself, and every copied node gets explicit options, so filling
/// the copy never looks up through its own parents either.
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
            case JsonValue value:
                return Leaf(value, inherited);
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
            var variant = key.ToUpperInvariant();
            if (string.Equals(variant, key, StringComparison.Ordinal))
            {
                variant = key.ToLowerInvariant();
                if (string.Equals(variant, key, StringComparison.Ordinal))
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

    /// <summary>
    /// A copy of a leaf with explicit options. <see cref="JsonNode.DeepClone"/> would look the options up through the
    /// source's parents; it is used only for a value of a type not listed here.
    /// </summary>
    private static JsonNode? Leaf(JsonValue value, JsonNodeOptions options)
    {
        // Parsed JSON first, then exact types; integers before floating point, so no value is ever read as a wider type.
        if (value.TryGetValue<JsonElement>(out var element))
        {
            return JsonValue.Create(element.Clone(), options);
        }

        if (value.TryGetValue<string>(out var text))
        {
            return JsonValue.Create(text, options);
        }

        if (value.TryGetValue<bool>(out var flag))
        {
            return JsonValue.Create(flag, options);
        }

        if (value.TryGetValue<int>(out var int32))
        {
            return JsonValue.Create(int32, options);
        }

        if (value.TryGetValue<long>(out var int64))
        {
            return JsonValue.Create(int64, options);
        }

        if (value.TryGetValue<ulong>(out var uint64))
        {
            return JsonValue.Create(uint64, options);
        }

        if (value.TryGetValue<uint>(out var uint32))
        {
            return JsonValue.Create(uint32, options);
        }

        if (value.TryGetValue<short>(out var int16))
        {
            return JsonValue.Create(int16, options);
        }

        if (value.TryGetValue<ushort>(out var uint16))
        {
            return JsonValue.Create(uint16, options);
        }

        if (value.TryGetValue<byte>(out var uint8))
        {
            return JsonValue.Create(uint8, options);
        }

        if (value.TryGetValue<sbyte>(out var int8))
        {
            return JsonValue.Create(int8, options);
        }

        if (value.TryGetValue<decimal>(out var money))
        {
            return JsonValue.Create(money, options);
        }

        if (value.TryGetValue<double>(out var number))
        {
            return JsonValue.Create(number, options);
        }

        if (value.TryGetValue<float>(out var single))
        {
            return JsonValue.Create(single, options);
        }

        if (value.TryGetValue<char>(out var character))
        {
            return JsonValue.Create(character, options);
        }

        if (value.TryGetValue<Guid>(out var guid))
        {
            return JsonValue.Create(guid, options);
        }

        if (value.TryGetValue<DateTime>(out var dateTime))
        {
            return JsonValue.Create(dateTime, options);
        }

        if (value.TryGetValue<DateTimeOffset>(out var dateTimeOffset))
        {
            return JsonValue.Create(dateTimeOffset, options);
        }

        return value.DeepClone();
    }
}
