using System;
using System.Buffers;
using System.Collections.Generic;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Logbird.Internal;

/// <summary>
/// Measures caller-built event data iteratively, before anything walks it recursively (cloning, redaction, writing):
/// a deeply nested tree is dropped as invalid instead of exhausting the host's stack, and an event whose text alone
/// already exceeds the size limit is dropped before it is copied or serialized.
/// </summary>
internal static class JsonDepth
{
    /// <summary>Levels allowed inside metadata and change values; the event envelope adds a few on top.</summary>
    public const int Max = 48;

    public enum Shape
    {
        Ok,
        TooDeep,
        TooLarge,
    }

    public static bool Exceeds(AuditEvent e) => Measure(e, long.MaxValue) == Shape.TooDeep;

    /// <summary>
    /// Checks depth and a lower bound of the UTF-8 size (every UTF-16 code unit of text is at least one byte), stopping
    /// as soon as either limit is passed.
    /// </summary>
    public static Shape Measure(AuditEvent e, long maxBytes)
    {
        long size = 0;
        bool Add(string? text)
        {
            size += text?.Length ?? 0;
            return size > maxBytes;
        }

        if (Add(e.Action) || Add(e.Id) || Add(e.Description) || Add(e.Environment) || Add(e.Outcome) || Add(e.Severity) || Add(e.Source)
            || Add(e.Actor?.Id) || Add(e.Actor?.Name) || Add(e.Actor?.Email) || Add(e.Tenant?.Id) || Add(e.Tenant?.Name)
            || Add(e.Executor?.Id) || Add(e.Executor?.Name) || Add(e.Impersonator?.Name))
        {
            return Shape.TooLarge;
        }

        if (e.EmitTargets)
        {
            foreach (var target in e.Targets)
            {
                if (target is not null && (Add(target.Type) || Add(target.Id) || Add(target.Name)))
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

    public static bool Exceeds(JsonNode? root, int max = Max)
    {
        long size = 0;
        return Walk(root, max, long.MaxValue, ref size) == Shape.TooDeep;
    }

    private static Shape Walk(JsonNode? root, int max, long maxBytes, ref long size)
    {
        if (root is null)
        {
            return Shape.Ok;
        }

        // Before enumerating a container (which, for a parsed node, would build every child), write it once into a
        // counting buffer that stops at a budget: a parsed node is written straight from its document, so an oversized or
        // overdeep tree is rejected with constant memory.
        if (maxBytes != long.MaxValue && root is JsonObject or JsonArray)
        {
            var precheck = Precheck(root, max, maxBytes - size);
            if (precheck != Shape.Ok)
            {
                return precheck;
            }
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
                case JsonValue value when value.TryGetValue<string>(out var text):
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

    /// <summary>
    /// Writes <paramref name="root"/> through a counting buffer. The writer's relaxed escaping writes at most six bytes for
    /// each byte Logbird's own serializer writes (a one-byte character such as DEL escaped as a six-byte sequence), so
    /// passing six times the remaining budget proves the event too large. Memory stays bounded either way: the buffer is
    /// reused, and a tree that passes holds at most six times the limit of JSON text for the walk that follows. Writer
    /// depth equals the walk's container depth, so passing <paramref name="max"/> proves it too deep. Anything else (for
    /// example a lone surrogate the writer refuses) leaves the decision to the walk.
    /// </summary>
    private static Shape Precheck(JsonNode root, int max, long remaining)
    {
        if (remaining < 0)
        {
            return Shape.TooLarge;
        }

        if (remaining > long.MaxValue / 6)
        {
            return Shape.Ok;
        }

        var counter = new CountingBuffer(remaining * 6);
        Utf8JsonWriter? writer = null;
        try
        {
            writer = new Utf8JsonWriter(counter, new JsonWriterOptions { MaxDepth = max, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
            root.WriteTo(writer);
            writer.Flush();
            return Shape.Ok;
        }
        catch (BudgetExceededException)
        {
            return Shape.TooLarge;
        }
        catch (InvalidOperationException) when (writer is not null && writer.CurrentDepth >= max)
        {
            return Shape.TooDeep;
        }
        catch (Exception)
        {
            return Shape.Ok;
        }
        finally
        {
            try
            {
                writer?.Dispose();
            }
            catch (Exception)
            {
                // Disposing flushes what is pending into the counter, which may stop at its budget again.
            }
        }
    }

    private sealed class BudgetExceededException : Exception
    {
    }

    /// <summary>Counts what is written into one reused buffer and stops once the budget is passed.</summary>
    private sealed class CountingBuffer(long budget) : IBufferWriter<byte>
    {
        private byte[] _buffer = new byte[4096];
        private long _written;

        public void Advance(int count)
        {
            _written += count;
            if (_written > budget)
            {
                throw new BudgetExceededException();
            }
        }

        public Memory<byte> GetMemory(int sizeHint = 0)
        {
            // The writer asks for at most eighteen bytes per character of the value it is about to write (six for its
            // worst-case escaping, times three for transcoding), and Logbird writes at least one byte per character, so a
            // request beyond three times the budget (eighteen times the remaining limit) proves that value alone is too
            // large. This also bounds the buffer.
            if (sizeHint > (budget * 3) + 1024)
            {
                throw new BudgetExceededException();
            }

            if (sizeHint > _buffer.Length)
            {
                _buffer = new byte[sizeHint];
            }

            return _buffer;
        }

        public Span<byte> GetSpan(int sizeHint = 0) => GetMemory(sizeHint).Span;
    }
}
