using System.Collections.Generic;
using System.Text.Json.Nodes;

namespace Logbird.Internal;

/// <summary>
/// Measures caller-built event data iteratively, before anything copies it: its depth against <see cref="Max"/>, and its
/// text against the memory guard, so an event beyond either is dropped before it is copied.
/// </summary>
internal static class JsonSize
{
    /// <summary>
    /// Levels allowed inside metadata and change values; the event envelope adds a few on top. This is the server's own limit
    /// for storing numbers exactly (EXACT_NUMBER_MAX_DEPTH in its contracts). Every SDK step that walks the data (copying,
    /// redaction, writing) is iterative; what still recurses per level is inside System.Text.Json (a node looks its options
    /// up through its parents), which this limit keeps well inside even a 256 KB thread stack.
    /// </summary>
    public const int Max = 1_000;

    /// <summary>Levels allowed in a whole event's JSON: <see cref="Max"/> plus the envelope.</summary>
    public const int MaxEventJson = Max + 8;

    public enum Shape
    {
        Ok,
        TooDeep,
        TooLarge,
    }

    public static bool Exceeds(AuditEvent e) => Measure(e, long.MaxValue) == Shape.TooDeep;

    public static bool Exceeds(JsonNode? root, int max)
    {
        long size = 0;
        return Walk(root, max, long.MaxValue, ref size) == Shape.TooDeep;
    }

    /// <summary>
    /// Checks depth and a lower bound of the UTF-8 size (every UTF-16 code unit of text is at least one byte), stopping
    /// as soon as either limit is passed.
    /// </summary>
    /// <summary>The fewest bytes a target adds besides its text: <c>{"type":"","id":""}</c>.</summary>
    internal const int TargetFraming = 19;

    public static Shape Measure(AuditEvent e, long maxBytes)
    {
        long size = 0;
        bool Add(string? text)
        {
            size += text?.Length ?? 0;
            return size > maxBytes;
        }

        bool AddBytes(int bytes)
        {
            size += bytes;
            return size > maxBytes;
        }

        if (Add(e.Action) || Add(e.Id) || Add(e.Description) || Add(e.Environment) || Add(e.Outcome) || Add(e.Severity) || Add(e.Source)
            || Add(e.Actor?.Type) || Add(e.Actor?.Id) || Add(e.Actor?.Name) || Add(e.Actor?.Email) || Add(e.Tenant?.Id) || Add(e.Tenant?.Name)
            || Add(e.Executor?.Type) || Add(e.Executor?.Id) || Add(e.Executor?.Name) || Add(e.Executor?.JobId)
            || Add(e.Impersonator?.Id) || Add(e.Impersonator?.Name))
        {
            return Shape.TooLarge;
        }

        if (e.EmitTargets)
        {
            foreach (var target in e.Targets)
            {
                // Each target is written as {"type":…,"id":…} at least: 19 bytes of framing ({"type":"","id":""}) besides
                // its text, so a long list of empty targets is measured too, before anything copies it.
                if (target is not null && (AddBytes(TargetFraming) || Add(target.Type) || Add(target.Id) || Add(target.Name)))
                {
                    return Shape.TooLarge;
                }
            }
        }

        var shape = Walk(e.MetadataOrNull, Max, maxBytes, ref size);
        if (shape != Shape.Ok || !e.EmitChanges)
        {
            return shape;
        }

        foreach (var change in e.Changes)
        {
            if (change is null)
            {
                continue;
            }

            if (Add(change.Field))
            {
                return Shape.TooLarge;
            }

            shape = Walk(change.Before, Max, maxBytes, ref size);
            if (shape == Shape.Ok)
            {
                shape = Walk(change.After, Max, maxBytes, ref size);
            }

            if (shape != Shape.Ok)
            {
                return shape;
            }
        }

        return Shape.Ok;
    }

    private static Shape Walk(JsonNode? root, int max, long maxBytes, ref long size)
    {
        if (root is null)
        {
            return Shape.Ok;
        }

        var pending = new Stack<(JsonNode Node, int Depth)>();
        pending.Push((root, 1));
        while (pending.Count > 0)
        {
            var (node, depth) = pending.Pop();
            if (depth > max)
            {
                return Shape.TooDeep;
            }

            // A lower bound of the UTF-8 text, exact for ASCII without escapes: each value costs at least one byte (a
            // number's digit, a bracket or brace pair counted with its separators below), and the budget is checked as each
            // member is counted, so a huge shallow array stops early instead of being walked or queued whole.
            size++;

            switch (node)
            {
                case JsonObject obj:
                    foreach (var pair in obj)
                    {
                        // "key": plus a comma (the closing brace stands in for the last comma).
                        size += pair.Key.Length + 4;
                        if (pair.Value is null)
                        {
                            size += 4;
                        }
                        else
                        {
                            pending.Push((pair.Value, depth + 1));
                        }

                        if (size > maxBytes)
                        {
                            return Shape.TooLarge;
                        }
                    }

                    break;
                case JsonArray array:
                    foreach (var item in array)
                    {
                        // A comma (the closing bracket stands in for the last one).
                        size += 1;
                        if (item is null)
                        {
                            size += 4;
                        }
                        else
                        {
                            pending.Push((item, depth + 1));
                        }

                        if (size > maxBytes)
                        {
                            return Shape.TooLarge;
                        }
                    }

                    break;
                case JsonValue value when JsJson.TryGetString(value, out var text):
                    // The two quotes; the first byte was counted above.
                    size += text.Length + 1;
                    break;
                case JsonValue value when value.TryGetValue<bool>(out var flag):
                    size += flag ? 3 : 4;
                    break;
            }

            if (size > maxBytes)
            {
                return Shape.TooLarge;
            }
        }

        return Shape.Ok;
    }
}
