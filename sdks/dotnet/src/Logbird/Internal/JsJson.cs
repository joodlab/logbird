using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

// netstandard2.0 has no span-based overloads for these; the same code builds for every target.
#pragma warning disable CA1845, CA1846

namespace Logbird.Internal;

/// <summary>
/// Writes JSON exactly like JavaScript's <c>JSON.stringify</c>, so events are byte-identical to the TypeScript SDK's:
/// non-ASCII text (including emoji) stays raw, control characters use the short or <c>\u00xx</c> escapes, and lone
/// surrogates are escaped as <c>\udxxx</c> instead of being replaced. The server keys event identity on the parsed
/// input, so a replay from either SDK must parse to the same values. No reflection: trimming and AOT safe.
/// </summary>
internal static class JsJson
{
    public static byte[] ToUtf8(JsonNode node) => ToUtf8(node, long.MaxValue)!;

    /// <summary>
    /// The JSON as UTF-8, or null as soon as it would exceed <paramref name="maxBytes"/>. The writer counts the UTF-8 bytes
    /// of everything it appends (escapes, multi-byte characters and raw number tokens included) before appending it, so
    /// the output never grows past the limit and an oversized value is never written whole.
    /// </summary>
    public static byte[]? ToUtf8(JsonNode node, long maxBytes)
    {
        var output = new Output(maxBytes);
        try
        {
            Write(output, node);
        }
        catch (TooLong)
        {
            return null;
        }

        // Lone surrogates were escaped above, so the text is valid UTF-16 and encodes to valid UTF-8 of exactly the
        // counted length.
        return Encoding.UTF8.GetBytes(output.Text.ToString());
    }

    /// <summary>Thrown by the writer once the output would pass its limit; never escapes <see cref="ToUtf8(JsonNode, long)"/>.</summary>
    private sealed class TooLong : Exception;

    /// <summary>The text being written and its length in UTF-8 bytes, checked against the limit before each append.</summary>
    private sealed class Output(long limit)
    {
        public StringBuilder Text { get; } = new(512);

        public long Bytes { get; private set; }

        /// <summary>Accounts <paramref name="bytes"/> more UTF-8 bytes, or throws if they would pass the limit.</summary>
        public void Reserve(long bytes)
        {
            Require(bytes);
            Bytes += bytes;
        }

        /// <summary>Throws if <paramref name="bytes"/> more could not fit, without accounting them.</summary>
        public void Require(long bytes)
        {
            if (Bytes + bytes > limit)
            {
                throw new TooLong();
            }
        }

        /// <summary>Appends ASCII text (punctuation, literals, number tokens): one byte per character.</summary>
        public void Ascii(char c)
        {
            Reserve(1);
            Text.Append(c);
        }

        public void Ascii(string text)
        {
            Reserve(text.Length);
            Text.Append(text);
        }
    }

    public static string Quote(string value)
    {
        var output = new Output(long.MaxValue);
        AppendString(output, value);
        return output.Text.ToString();
    }

    /// <summary>
    /// Writes a node without recursion: open objects and arrays wait on an explicit stack, so any depth the size limit
    /// allows is written on any thread's stack.
    /// </summary>
    private static void Write(Output builder, JsonNode? root)
    {
        var open = new Stack<Frame>();
        WriteOne(builder, root, open);
        while (open.Count > 0)
        {
            var frame = open.Peek();
            if (frame.Members is { } members)
            {
                if (!members.MoveNext())
                {
                    builder.Ascii('}');
                    open.Pop();
                    continue;
                }

                if (!frame.First)
                {
                    builder.Ascii(',');
                }

                frame.First = false;
                AppendString(builder, members.Current.Key);
                builder.Ascii(':');
                WriteOne(builder, members.Current.Value, open);
            }
            else
            {
                var array = frame.Array!;
                if (frame.Index >= array.Count)
                {
                    builder.Ascii(']');
                    open.Pop();
                    continue;
                }

                if (frame.Index > 0)
                {
                    builder.Ascii(',');
                }

                WriteOne(builder, array[frame.Index++], open);
            }
        }
    }

    /// <summary>Writes a leaf, or opens an object or array whose contents the caller's loop writes.</summary>
    private static void WriteOne(Output builder, JsonNode? node, Stack<Frame> open)
    {
        switch (node)
        {
            case null:
                builder.Ascii("null");
                break;
            case JsonObject obj:
                builder.Ascii('{');
                open.Push(new Frame { Members = JavaScriptOrder(obj).GetEnumerator() });
                break;
            case JsonArray array:
                builder.Ascii('[');
                open.Push(new Frame { Array = array });
                break;
            case JsonValue value:
                WriteValue(builder, value);
                break;
        }
    }

    /// <summary>An object or array being written: its remaining members, or its array and the next index.</summary>
    private sealed class Frame
    {
        public IEnumerator<KeyValuePair<string, JsonNode?>>? Members;

        public JsonArray? Array;

        public int Index;

        public bool First = true;
    }

    /// <summary>
    /// The text of a string value. A parsed JSON string can hold an escaped lone surrogate ("\ud800"), which
    /// JsonElement.GetString refuses (and TryGetValue&lt;string&gt; throws for): its UTF-16 code units are decoded from
    /// the raw text instead, so every reader of an event (the shape check, redaction, the writer) sees it exactly as parsed.
    /// </summary>
    internal static bool TryGetString(JsonValue value, out string text)
    {
        if (value.TryGetValue<JsonElement>(out var parsed))
        {
            text = parsed.ValueKind == JsonValueKind.String ? DecodeString(parsed.GetRawText()) : string.Empty;
            return parsed.ValueKind == JsonValueKind.String;
        }

        if (value.TryGetValue<string>(out var own))
        {
            text = own;
            return true;
        }

        text = string.Empty;
        return false;
    }

    /// <summary>
    /// The number of UTF-16 code units in a string value, without decoding it: a parsed string's escapes are counted from
    /// its raw text (System.Text.Json 8 offers no allocation-free view of it, so the raw token is read once).
    /// </summary>
    internal static bool TryGetStringLength(JsonValue value, out long units)
    {
        if (value.TryGetValue<JsonElement>(out var parsed))
        {
            units = parsed.ValueKind == JsonValueKind.String ? DecodedLength(parsed.GetRawText()) : 0;
            return parsed.ValueKind == JsonValueKind.String;
        }

        if (value.TryGetValue<string>(out var own))
        {
            units = own.Length;
            return true;
        }

        units = 0;
        return false;
    }

    /// <summary>The UTF-16 code units <see cref="DecodeString"/> would produce for a JSON string literal (with its quotes).</summary>
    internal static long DecodedLength(string raw)
    {
        long units = 0;
        for (var i = 1; i < raw.Length - 1; i++)
        {
            if (raw[i] == (char)92)
            {
                // An escape is one code unit: a u escape spans six characters, the others two.
                i += raw[i + 1] == 'u' ? 5 : 1;
            }

            units++;
        }

        return units;
    }

    private static void WriteValue(Output builder, JsonValue value)
    {
        if (TryGetString(value, out var text))
        {
            AppendString(builder, text);
            return;
        }

        if (value.TryGetValue<bool>(out var flag))
        {
            builder.Ascii(flag ? "true" : "false");
            return;
        }

        if (value.TryGetValue<char>(out var character))
        {
            AppendString(builder, character.ToString());
            return;
        }

        // Values that serialize as strings (Guid, DateTime, ...) are re-quoted with the JavaScript escaping. Numbers are
        // laid out like JavaScript's Number#toString but keep every significant digit, so long, ulong and decimal values
        // stay exact (they never pass through double).
        string json;
        if (value.TryGetValue<JsonElement>(out var element) && element.ValueKind == JsonValueKind.Number)
        {
            // Parsed JSON: send the number exactly as it was written (a maintainer decision: never round on purpose). A
            // number token is ASCII.
            builder.Ascii(element.GetRawText());
            return;
        }
        else if (value.TryGetValue<JsonElement>(out element))
        {
            json = element.GetRawText();
        }
        else if (value.TryGetValue<double>(out var number))
        {
            json = Shortest(number);
        }
        else if (value.TryGetValue<float>(out var single))
        {
            json = Shortest(single);
        }
        else
        {
            json = value.ToJsonString();
        }

        if (json.Length > 0 && json[0] == '"')
        {
            using var document = JsonDocument.Parse(json);
            AppendString(builder, document.RootElement.GetString()!);
        }
        else if (json is "null" or "true" or "false")
        {
            builder.Ascii(json);
        }
        else if (json is "NaN" or "Infinity" or "-Infinity")
        {
            builder.Ascii("null");
        }
        else
        {
            builder.Ascii(FormatNumber(json));
        }
    }

    /// <summary>
    /// The shortest decimal text that reads back as the same double, as JavaScript writes it. NaN and infinities have
    /// no JSON form: JavaScript writes <c>null</c>, and so does this SDK.
    /// </summary>
    internal static string Shortest(double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value))
        {
            return "null";
        }

#if NET8_0_OR_GREATER
        // .NET Core 3.0 and later format "R" as the shortest round-trip text.
        return value.ToString("R", CultureInfo.InvariantCulture);
#else
        // .NET Framework's "R" is not always the shortest (double.Epsilon gives 4.94065645841247E-324); search instead.
        for (var precision = 1; precision <= 17; precision++)
        {
            var text = value.ToString("E" + (precision - 1).ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
            // TryParse, not Parse: a trial that rounds past MaxValue (2E+308 for double.MaxValue) overflows, which Parse
            // reports by throwing on .NET Framework.
            if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) && parsed == value)
            {
                return text;
            }
        }

        return value.ToString("R", CultureInfo.InvariantCulture);
#endif
    }

    internal static string Shortest(float value)
    {
        if (float.IsNaN(value) || float.IsInfinity(value))
        {
            return "null";
        }

        for (var precision = 1; precision <= 9; precision++)
        {
            var text = value.ToString("E" + (precision - 1).ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
            if (float.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) && parsed == value)
            {
                return text;
            }
        }

        return value.ToString("R", CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// The UTF-16 code units of a JSON string literal (with its quotes), lone surrogates included, exactly as JavaScript's
    /// JSON.parse reads them.
    /// </summary>
    internal static string DecodeString(string raw)
    {
        var builder = new StringBuilder(raw.Length);
        for (var i = 1; i < raw.Length - 1; i++)
        {
            var c = raw[i];
            if (c != (char)92)
            {
                builder.Append(c);
                continue;
            }

            var escape = raw[++i];
            switch (escape)
            {
                case 'b': builder.Append((char)8); break;
                case 'f': builder.Append((char)12); break;
                case 'n': builder.Append((char)10); break;
                case 'r': builder.Append((char)13); break;
                case 't': builder.Append((char)9); break;
                case 'u':
                    builder.Append((char)int.Parse(raw.Substring(i + 1, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture));
                    i += 4;
                    break;
                default:
                    // The quote, the reverse solidus and the solidus stand for themselves.
                    builder.Append(escape);
                    break;
            }
        }

        return builder.ToString();
    }

    /// <summary>
    /// JavaScript lists integer-like keys ("0", "7", "42", up to 2^32 - 2, without leading zeros) first, ascending,
    /// then the other keys in insertion order.
    /// </summary>
    private static IEnumerable<KeyValuePair<string, JsonNode?>> JavaScriptOrder(JsonObject obj)
    {
        if (!obj.Any(pair => IsArrayIndex(pair.Key)))
        {
            return obj;
        }

        return obj.Where(pair => IsArrayIndex(pair.Key)).OrderBy(pair => uint.Parse(pair.Key, CultureInfo.InvariantCulture))
            .Concat(obj.Where(pair => !IsArrayIndex(pair.Key)));
    }

    private static bool IsArrayIndex(string key)
    {
        if (key.Length is 0 or > 10 || (key.Length > 1 && key[0] == '0'))
        {
            return false;
        }

        foreach (var c in key)
        {
            if (c is < '0' or > '9')
            {
                return false;
            }
        }

        return ulong.Parse(key, CultureInfo.InvariantCulture) <= 4_294_967_294UL;
    }

    /// <summary>
    /// Lays out a JSON number like ECMAScript's Number::toString (plain digits up to 21 integer digits, otherwise
    /// <c>d.ddde+x</c>; <c>-0</c> becomes <c>0</c>) while keeping all significant digits of the input.
    /// </summary>
    internal static string FormatNumber(string json)
    {
        var position = 0;
        var negative = json[0] == '-';
        if (negative)
        {
            position++;
        }

        var digits = new StringBuilder();
        var pointPosition = 0;
        while (position < json.Length && char.IsDigit(json[position]))
        {
            digits.Append(json[position++]);
            pointPosition++;
        }

        if (position < json.Length && json[position] == '.')
        {
            position++;
            while (position < json.Length && char.IsDigit(json[position]))
            {
                digits.Append(json[position++]);
            }
        }

        if (position < json.Length && (json[position] == 'e' || json[position] == 'E'))
        {
            pointPosition += int.Parse(json.Substring(position + 1), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        }

        var text = digits.ToString();
        var leading = 0;
        while (leading < text.Length && text[leading] == '0')
        {
            leading++;
        }

        text = text.Substring(leading).TrimEnd('0');
        pointPosition -= leading;
        if (text.Length == 0)
        {
            return "0";
        }

        var k = text.Length;
        var n = pointPosition;
        string result;
        if (k <= n && n <= 21)
        {
            result = text + new string('0', n - k);
        }
        else if (n is > 0 and <= 21)
        {
            result = text.Substring(0, n) + "." + text.Substring(n);
        }
        else if (n is > -6 and <= 0)
        {
            result = "0." + new string('0', -n) + text;
        }
        else
        {
            var exponent = n - 1;
            var mantissa = k == 1 ? text : text.Substring(0, 1) + "." + text.Substring(1);
            result = mantissa + "e" + (exponent < 0 ? "-" : "+") + System.Math.Abs(exponent).ToString(CultureInfo.InvariantCulture);
        }

        return negative ? "-" + result : result;
    }

    private static void AppendString(Output output, string value)
    {
        // Every code unit is at least one byte, so a value that cannot fit even unescaped is refused before it is read.
        output.Require(value.Length + 2L);
        var builder = output.Text;
        output.Ascii('"');
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            switch (c)
            {
                case '"':
                    output.Reserve(2);
                    builder.Append('\\').Append('"');
                    break;
                case '\\':
                    output.Reserve(2);
                    builder.Append('\\').Append('\\');
                    break;
                case '\b':
                    output.Reserve(2);
                    builder.Append('\\').Append('b');
                    break;
                case '\f':
                    output.Reserve(2);
                    builder.Append('\\').Append('f');
                    break;
                case '\n':
                    output.Reserve(2);
                    builder.Append('\\').Append('n');
                    break;
                case '\r':
                    output.Reserve(2);
                    builder.Append('\\').Append('r');
                    break;
                case '\t':
                    output.Reserve(2);
                    builder.Append('\\').Append('t');
                    break;
                default:
                    if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
                    {
                        // A surrogate pair is one code point outside the BMP: four UTF-8 bytes.
                        output.Reserve(4);
                        builder.Append(c).Append(value[++i]);
                    }
                    else if (c < 0x20 || char.IsSurrogate(c))
                    {
                        // Controls and lone surrogates are escaped as six ASCII bytes.
                        output.Reserve(6);
                        builder.Append('\\').Append('u').Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        output.Reserve(c < 0x80 ? 1 : c < 0x800 ? 2 : 3);
                        builder.Append(c);
                    }

                    break;
            }
        }

        output.Ascii('"');
    }
}
