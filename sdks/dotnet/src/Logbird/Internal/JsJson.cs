using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

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
                foreach (var pair in obj)
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

        // Numbers keep System.Text.Json's exact digits (long, ulong and decimal never pass through double). Other values
        // that serialize as strings (Guid, DateTime, ...) are re-quoted with the JavaScript escaping.
        var json = value.ToJsonString();
        if (json.Length > 0 && json[0] == '"')
        {
            using var document = JsonDocument.Parse(json);
            AppendString(builder, document.RootElement.GetString()!);
        }
        else
        {
            builder.Append(json);
        }
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
