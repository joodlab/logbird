using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Logbird.Internal;

namespace Logbird;

/// <summary>
/// Controls how secrets are removed before an event leaves your process. Enabled by default with
/// <see cref="Redactor.DefaultSecretKeys"/>, which matches passwords, secrets, tokens, one-time codes, API keys,
/// authorization headers, cookies, credentials and private keys.
/// </summary>
/// <remarks>
/// A matching key keeps its name and its value becomes <see cref="Replacement"/>, at any depth (actor, targets,
/// context, metadata). For a change whose <c>field</c> matches <see cref="ChangeFields"/>, the recorded before and
/// after values are replaced. The top-level <c>id</c> and <c>action</c> are never redacted. The default pattern does
/// not cover personal data: add your own keys with <see cref="AddKeys"/>.
/// </remarks>
public sealed class RedactionOptions
{
    /// <summary>Whether redaction runs. Defaults to <see langword="true"/>.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Object keys whose values are replaced. Defaults to <see cref="Redactor.DefaultSecretKeys"/>.</summary>
    public Regex Keys { get; set; } = Redactor.DefaultSecretKeys;

    /// <summary>Change fields whose before and after values are replaced. Defaults to <see cref="Keys"/>.</summary>
    public Regex? ChangeFields { get; set; }

    /// <summary>The replacement value. Defaults to <c>[redacted]</c>.</summary>
    public string Replacement { get; set; } = Redactor.DefaultReplacement;

    /// <summary>
    /// Adds key names to <see cref="Keys"/> while keeping the current pattern, for example <c>AddKeys("email", "phone")</c>.
    /// Names are matched as case-insensitive substrings, like the default pattern.
    /// </summary>
    /// <param name="names">Plain key names; they are escaped, not treated as patterns.</param>
    /// <returns>These options.</returns>
    public RedactionOptions AddKeys(params string[] names)
    {
        Guard.NotNull(names, nameof(names));
        if (names.Length == 0)
        {
            return this;
        }

        var added = string.Join("|", names.Select(Regex.Escape));
        Keys = new Regex($"{Keys}|{added}", Keys.Options | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        return this;
    }

    internal Redactor? CreateRedactor()
        => Enabled ? new Redactor(Keys, ChangeFields, Replacement) : null;
}

/// <summary>
/// Removes secrets from event JSON. Equivalent to the TypeScript SDK's <c>redact()</c>: works on a deep copy, keeps
/// keys, replaces values whose key matches, and replaces present before/after values of matching change fields.
/// </summary>
public sealed class Redactor
{
    /// <summary>The default replacement value.</summary>
    public const string DefaultReplacement = "[redacted]";

    /// <summary>The default secret key pattern, identical to the TypeScript SDK's <c>DEFAULT_SECRET_KEYS</c>.</summary>
    public static readonly Regex DefaultSecretKeys = new(
        "passw(or)?d|secret|token|otp|api[-_]?key|authorization|cookie|credential|private[-_]?key",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private readonly Regex _keys;
    private readonly Regex _changeFields;
    private readonly string _replacement;

    /// <summary>Creates a redactor.</summary>
    /// <param name="keys">Key pattern; defaults to <see cref="DefaultSecretKeys"/>.</param>
    /// <param name="changeFields">Change field pattern; defaults to <paramref name="keys"/>.</param>
    /// <param name="replacement">Replacement value; defaults to <c>[redacted]</c>.</param>
    public Redactor(Regex? keys = null, Regex? changeFields = null, string? replacement = null)
    {
        _keys = keys ?? DefaultSecretKeys;
        _changeFields = changeFields ?? _keys;
        _replacement = replacement ?? DefaultReplacement;
    }

    /// <summary>Returns a redacted deep copy of an event JSON object. The input is not changed.</summary>
    /// <param name="eventJson">The event as JSON.</param>
    /// <exception cref="ArgumentException">The JSON nests deeper than 64 levels.</exception>
    public JsonObject Redact(JsonObject eventJson)
    {
        if (JsonDepth.Exceeds(Guard.NotNull(eventJson, nameof(eventJson)), 64))
        {
            throw new ArgumentException("The event JSON nests deeper than 64 levels.", nameof(eventJson));
        }

        var copy = (JsonObject)eventJson.DeepClone();
        RedactInPlace(copy);
        return copy;
    }

    internal void RedactInPlace(JsonObject copy)
    {
        if (copy["changes"] is JsonArray changes)
        {
            foreach (var item in changes)
            {
                if (item is not JsonObject change || !_changeFields.IsMatch(FieldText(change["field"])))
                {
                    continue;
                }

                if (change.ContainsKey("before"))
                {
                    change["before"] = _replacement;
                }

                if (change.ContainsKey("after"))
                {
                    change["after"] = _replacement;
                }
            }
        }

        Walk(copy, top: true);
    }

    private void Walk(JsonNode? node, bool top = false)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var key in obj.Select(pair => pair.Key).ToList())
                {
                    if (top && key is "id" or "action")
                    {
                        continue;
                    }

                    if (_keys.IsMatch(key))
                    {
                        obj[key] = _replacement;
                    }
                    else
                    {
                        Walk(obj[key]);
                    }
                }

                break;
            case JsonArray array:
                // JavaScript walks arrays by index keys ("0", "1", ...); match them the same way.
                for (var i = 0; i < array.Count; i++)
                {
                    if (_keys.IsMatch(i.ToString(CultureInfo.InvariantCulture)))
                    {
                        array[i] = _replacement;
                    }
                    else
                    {
                        Walk(array[i]);
                    }
                }

                break;
        }
    }

    // JavaScript's RegExp.test coerces a non-string field to text.
    private static string FieldText(JsonNode? field)
        => field switch
        {
            null => "null",
            JsonValue value when value.TryGetValue<string>(out var text) => text,
            _ => field.ToJsonString(),
        };
}
