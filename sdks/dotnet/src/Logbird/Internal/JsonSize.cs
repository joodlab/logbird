using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Logbird.Internal;

/// <summary>
/// Measures caller-built event data iteratively, before anything copies it: its depth against <see cref="Max"/>, and its
/// size against the memory guard, so an event beyond either is dropped before it is copied.
/// </summary>
/// <remarks>
/// The unit is a lower bound of the event's UTF-8 JSON: one byte per UTF-16 code unit of every carried text (envelope
/// fields, context, targets, change fields, metadata keys and values), the JSON punctuation of repeated structures
/// (targets, changes, objects, arrays) and literals, and a number's digits as written when it was parsed (at least one
/// byte for a number built in code). Escapes and multi-byte characters are not expanded, so the guard never refuses data
/// whose JSON would be smaller than the guard.
/// </remarks>
internal static class JsonSize
{
    /// <summary>
    /// Levels allowed inside metadata and each change value (a non-null member deeper than this is refused), checked on the
    /// caller's data before anything copies it. A value that is part of a larger tree of the caller's also counts the
    /// parents it has there. Every SDK step that walks the data (measuring, copying, redaction, writing)
    /// is iterative; what still recurses per level is inside System.Text.Json (a node looks its options up through its
    /// parents), which this limit keeps well inside a 256 KB thread stack (tested). The number is the server's
    /// EXACT_NUMBER_MAX_DEPTH, which the server applies to the whole event and only when it holds a number a double cannot
    /// keep exactly; see <see cref="DropReason.Invalid"/> for what that difference means.
    /// </summary>
    public const int Max = 1_000;

    /// <summary>Levels allowed in a whole event's JSON: <see cref="Max"/> plus the envelope.</summary>
    public const int MaxEventJson = Max + 8;

    /// <summary>The fewest bytes a target adds besides its text: <c>{"type":"","id":""}</c> and a comma.</summary>
    internal const int TargetFraming = 20;

    /// <summary>The fewest bytes a change adds besides its field text and values: <c>{"field":""}</c> and a comma.</summary>
    internal const int ChangeFraming = 13;

    public enum Shape
    {
        Ok,
        TooDeep,
        TooLarge,
    }

    /// <summary>Whether the event's data nests deeper than <see cref="Max"/>, whatever its size.</summary>
    public static bool Exceeds(AuditEvent e) => Measure(e, long.MaxValue) == Shape.TooDeep;

    public static bool Exceeds(JsonNode? root, int max)
    {
        long size = 0;
        return Walk(root, max, long.MaxValue, ref size) == Shape.TooDeep;
    }

    /// <summary>
    /// Checks depth and the size lower bound described on the class in one walk, stopping as soon as either limit is
    /// passed.
    /// </summary>
    public static Shape Measure(AuditEvent e, long maxBytes)
    {
        long size = 0;
        bool Add(string? text, int framing = 0)
        {
            size += (text?.Length ?? 0) + framing;
            return size > maxBytes;
        }

        if (Add(e.Action) || Add(e.Id) || Add(e.Description) || Add(e.Environment) || Add(e.Outcome) || Add(e.Severity) || Add(e.Source)
            || Add(e.SchemaVersion)
            || Add(e.Actor?.Type) || Add(e.Actor?.Id) || Add(e.Actor?.Name) || Add(e.Actor?.Email) || Add(e.Tenant?.Id) || Add(e.Tenant?.Name)
            || Add(e.Executor?.Type) || Add(e.Executor?.Id) || Add(e.Executor?.Name) || Add(e.Executor?.JobId)
            || Add(e.Impersonator?.Id) || Add(e.Impersonator?.Name))
        {
            return Shape.TooLarge;
        }

        if (e.ContextOrNull is { } context
            && (Add(context.OperationId) || Add(context.ParentEventId) || Add(context.RequestId) || Add(context.TraceId)
                || Add(context.Ip) || Add(context.UserAgent)))
        {
            return Shape.TooLarge;
        }

        if (e.EmitTargets)
        {
            foreach (var target in e.Targets)
            {
                // A long list of empty targets is measured by its framing too, before anything copies it.
                if (target is not null && (Add(target.Type, TargetFraming) || Add(target.Id) || Add(target.Name)))
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

            // "before": and "after": with their commas when present; a present null value writes null.
            if (Add(change.Field, ChangeFraming + (change.HasBefore ? 10 : 0) + (change.HasAfter ? 9 : 0)))
            {
                return Shape.TooLarge;
            }

            shape = Value(change.HasBefore, change.Before, maxBytes, ref size);
            if (shape == Shape.Ok)
            {
                shape = Value(change.HasAfter, change.After, maxBytes, ref size);
            }

            if (shape != Shape.Ok)
            {
                return shape;
            }
        }

        return Shape.Ok;
    }

    private static Shape Value(bool present, JsonNode? value, long maxBytes, ref long size)
    {
        if (!present)
        {
            return Shape.Ok;
        }

        if (value is null)
        {
            size += 4;
            return size > maxBytes ? Shape.TooLarge : Shape.Ok;
        }

        return Walk(value, Max, maxBytes, ref size);
    }

    /// <summary>
    /// One frame per open level, so the walk holds at most <paramref name="max"/> frames however wide the data is. Leaves
    /// and empty containers are counted where they are met; the budget is checked after each member.
    /// </summary>
    private static Shape Walk(JsonNode? root, int max, long maxBytes, ref long size)
    {
        if (root is null)
        {
            return Shape.Ok;
        }

        // A value that is part of a larger tree of the caller's counts the parents it has there: System.Text.Json walks
        // through them, recursively, whenever it looks a node's options up. Reading Parent is a field read, so they are
        // counted without that walk, and a value too deep to read is refused before anything reads it.
        var outside = 0;
        for (var parent = root.Parent; parent is not null; parent = parent.Parent)
        {
            if (++outside >= max)
            {
                return Shape.TooDeep;
            }
        }

        if (root is not (JsonObject or JsonArray))
        {
            size += LeafBytes(root);
            return size > maxBytes ? Shape.TooLarge : Shape.Ok;
        }

        var frames = new Frame[16];
        var open = 0;
        size += Open(root, 1 + outside, ref frames, ref open);
        if (size > maxBytes)
        {
            // An empty root is counted whole and opens no level, so the loop below would not check it.
            return Shape.TooLarge;
        }
        while (open > 0)
        {
            ref var frame = ref frames[open - 1];
            JsonNode? member;
            if (frame.Members is { } members)
            {
                if (!members.MoveNext())
                {
                    members.Dispose();
                    open--;
                    continue;
                }

                // "key": and a comma (the closing brace stands in for the last comma).
                size += members.Current.Key.Length + 4;
                member = members.Current.Value;
            }
            else
            {
                var array = (JsonArray)frame.Node;
                if (frame.Index >= array.Count)
                {
                    open--;
                    continue;
                }

                // A comma (the closing bracket stands in for the last one).
                size += 1;
                member = array[frame.Index++];
            }

            var depth = frame.Depth + 1;
            if (member is null)
            {
                size += 4;
            }
            else if (depth > max)
            {
                return Shape.TooDeep;
            }
            else if (member is JsonObject or JsonArray)
            {
                // The frame reference is not used past this point: opening a level may grow the array.
                size += Open(member, depth, ref frames, ref open);
            }
            else
            {
                size += LeafBytes(member);
            }

            if (size > maxBytes)
            {
                return Shape.TooLarge;
            }
        }

        return Shape.Ok;
    }

    /// <summary>Opens a level for a non-empty object or array and returns its opening bytes; an empty one is counted whole.</summary>
    private static int Open(JsonNode container, int depth, ref Frame[] frames, ref int open)
    {
        var count = container is JsonObject obj ? obj.Count : ((JsonArray)container).Count;
        if (count == 0)
        {
            return 2;
        }

        if (open == frames.Length)
        {
            Array.Resize(ref frames, frames.Length * 2);
        }

        frames[open++] = new Frame(container, depth, container is JsonObject members ? members.GetEnumerator() : null);
        return 1;
    }

    private struct Frame(JsonNode node, int depth, IEnumerator<KeyValuePair<string, JsonNode?>>? members)
    {
        public readonly JsonNode Node = node;

        public readonly int Depth = depth;

        public readonly IEnumerator<KeyValuePair<string, JsonNode?>>? Members = members;

        public int Index;
    }

    /// <summary>The fewest bytes a leaf writes: its text and quotes for a string, its literal, or a number's digits.</summary>
    /// <remarks>
    /// Read with value-type probes first: each is compiled for its own type and never boxes, where asking a value built in
    /// code for its kind (<c>GetValueKind</c>) serializes it on System.Text.Json 8, and probing a number as a string boxes
    /// it. Only a value none of them match is probed as a string.
    /// </remarks>
    private static long LeafBytes(JsonNode leaf)
    {
        if (leaf is not JsonValue value)
        {
            return 1;
        }

        if (value.TryGetValue<JsonElement>(out var parsed))
        {
            return parsed.ValueKind switch
            {
                // A parsed string's code units, counted from its raw text without decoding it.
                JsonValueKind.String => JsJson.DecodedLength(parsed.GetRawText()) + 2,

                // A parsed number is sent exactly as written, so its digits count.
                JsonValueKind.Number => parsed.GetRawText().Length,
                JsonValueKind.True => 4,
                JsonValueKind.False => 5,
                JsonValueKind.Null => 4,
                _ => 1,
            };
        }

        if (value.TryGetValue<bool>(out var flag))
        {
            return flag ? 4 : 5;
        }

        // Numbers and other values built in code write at least one byte.
        if (value.TryGetValue<int>(out _) || value.TryGetValue<long>(out _) || value.TryGetValue<double>(out _)
            || value.TryGetValue<decimal>(out _) || value.TryGetValue<float>(out _) || value.TryGetValue<short>(out _)
            || value.TryGetValue<uint>(out _) || value.TryGetValue<ulong>(out _) || value.TryGetValue<byte>(out _)
            || value.TryGetValue<sbyte>(out _) || value.TryGetValue<ushort>(out _) || value.TryGetValue<char>(out _)
            || value.TryGetValue<Guid>(out _) || value.TryGetValue<DateTime>(out _) || value.TryGetValue<DateTimeOffset>(out _))
        {
            return 1;
        }

        return value.TryGetValue<string>(out var text) ? text.Length + 2 : 1;
    }
}
