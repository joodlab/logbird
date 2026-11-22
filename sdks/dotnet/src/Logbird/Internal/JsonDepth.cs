using System.Collections.Generic;
using System.Text.Json.Nodes;

namespace Logbird.Internal;

/// <summary>
/// Checks caller-built JSON depth iteratively, before anything walks it recursively (cloning, redaction, writing), so a
/// deeply nested tree is dropped as invalid instead of exhausting the host's stack.
/// </summary>
internal static class JsonDepth
{
    /// <summary>Levels allowed inside metadata and change values; the event envelope adds a few on top.</summary>
    public const int Max = 48;

    public static bool Exceeds(AuditEvent e)
    {
        if (Exceeds(e.MetadataOrNull))
        {
            return true;
        }

        if (!e.EmitChanges)
        {
            return false;
        }

        foreach (var change in e.Changes)
        {
            if (change is not null && (Exceeds(change.Before) || Exceeds(change.After)))
            {
                return true;
            }
        }

        return false;
    }

    public static bool Exceeds(JsonNode? root, int max = Max)
    {
        if (root is null)
        {
            return false;
        }

        var pending = new Stack<(JsonNode Node, int Depth)>();
        pending.Push((root, 1));
        while (pending.Count > 0)
        {
            var (node, depth) = pending.Pop();
            if (depth > max)
            {
                return true;
            }

            switch (node)
            {
                case JsonObject obj:
                    foreach (var pair in obj)
                    {
                        if (pair.Value is not null)
                        {
                            pending.Push((pair.Value, depth + 1));
                        }
                    }

                    break;
                case JsonArray array:
                    foreach (var item in array)
                    {
                        if (item is not null)
                        {
                            pending.Push((item, depth + 1));
                        }
                    }

                    break;
            }
        }

        return false;
    }
}
