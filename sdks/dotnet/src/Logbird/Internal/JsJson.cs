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
    public static byte[] ToUtf8(JsonNode node)
    {
        var builder = new StringBuilder(512);
        Write(builder, node);

        // Lone surrogates were escaped above, so the text is valid UTF-16 and encodes to valid UTF-8.
        return Encoding.UTF8.GetBytes(builder.ToString());
    }

    public static string Quote(string value)
    {
        var builder = new StringBuilder(value.Length + 2);
        AppendString(builder, value);
        return builder.ToString();
    }

    private static void Write(StringBuilder builder, JsonNode? node)
    {
        switch (node)
        {
            case null:
                builder.Append("null");
                break;
            case JsonObject obj:
                builder.Append('{');
                var first = true;
                foreach (var pair in JavaScriptOrder(obj))
                {
                    if (!first)
                    {
                        builder.Append(',');
                    }

                    first = false;
                    AppendString(builder, pair.Key);
                    builder.Append(':');
                    Write(builder, pair.Value);
                }

                builder.Append('}');
                break;
            case JsonArray array:
                builder.Append('[');
                for (var i = 0; i < array.Count; i++)
                {
                    if (i > 0)
                    {
                        builder.Append(',');
                    }

                    Write(builder, array[i]);
                }

                builder.Append(']');
                break;
            case JsonValue value:
                WriteValue(builder, value);
                break;
        }
    }

    private static void WriteValue(StringBuilder builder, JsonValue value)
    {
        if (value.TryGetValue<string>(out var text))
        {
            AppendString(builder, text);
            return;
        }

        if (value.TryGetValue<bool>(out var flag))
        {
            builder.Append(flag ? "true" : "false");
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
            // Parsed JSON: send the number exactly as it was written (a maintainer decision: never round on purpose).
            builder.Append(element.GetRawText());
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
            builder.Append(json);
        }
        else if (json is "NaN" or "Infinity" or "-Infinity")
        {
            builder.Append("null");
        }
        else
        {
            builder.Append(FormatNumber(json));
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
            if (double.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture) == value)
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
            if (float.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture) == value)
            {
                return text;
            }
        }

        return value.ToString("R", CultureInfo.InvariantCulture);
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

    private static void AppendString(StringBuilder builder, string value)
    {
        builder.Append('"');
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            switch (c)
            {
                case '"':
                    builder.Append('\\').Append('"');
                    break;
                case '\\':
                    builder.Append('\\').Append('\\');
                    break;
                case '\b':
                    builder.Append('\\').Append('b');
                    break;
                case '\f':
                    builder.Append('\\').Append('f');
                    break;
                case '\n':
                    builder.Append('\\').Append('n');
                    break;
                case '\r':
                    builder.Append('\\').Append('r');
                    break;
                case '\t':
                    builder.Append('\\').Append('t');
                    break;
                default:
                    var lone = (char.IsHighSurrogate(c) && (i + 1 >= value.Length || !char.IsLowSurrogate(value[i + 1])))
                        || (char.IsLowSurrogate(c) && (i == 0 || !char.IsHighSurrogate(value[i - 1])));
                    if (c < 0x20 || lone)
                    {
                        builder.Append('\\').Append('u').Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        builder.Append(c);
                    }

                    break;
            }
        }

        builder.Append('"');
    }
}
