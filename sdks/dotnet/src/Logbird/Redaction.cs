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
        Keys = new Regex($"{Keys}|{added}", Keys.Options | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, Keys.MatchTimeout);
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
    /// <exception cref="ArgumentException">The JSON nests deeper than 1,008 levels (1,000 inside metadata, plus the event envelope).</exception>
    public JsonObject Redact(JsonObject eventJson)
    {
        if (JsonSize.Exceeds(Guard.NotNull(eventJson, nameof(eventJson)), JsonSize.MaxEventJson))
        {
            throw new ArgumentException($"The event JSON nests deeper than {JsonSize.MaxEventJson} levels.", nameof(eventJson));
        }

        var copy = (JsonObject)JsonTree.Clone(eventJson)!;
        RedactInPlace(copy);
        return copy;
    }

    /// <summary>
    /// Field names that identify entities. They are never redacted: a redacted id would merge every identity into one.
    /// To pseudonymise an id, transform it before recording.
    /// </summary>
    public static IReadOnlyList<string> IdentifierFields { get; } = ["actor.id", "impersonator.id", "executor.id", "tenant.id", "targets[].type", "targets[].id"];

    private static readonly string[] StructuralKeys = ["actor", "impersonator", "executor", "tenant", "targets", "id", "type"];

    /// <summary>The identifier-related keys this redactor's patterns would match (they are exempt from redaction).</summary>
    internal List<string> IdentifierFieldsMatched()
    {
        var matched = new List<string>();
        foreach (var key in StructuralKeys)
        {
            try
            {
                if (_keys.IsMatch(key))
                {
                    matched.Add(key);
                }
            }
            catch (RegexMatchTimeoutException)
            {
                // A pattern that times out on a field name is reported as matching; startup must not fail.
                matched.Add(key);
            }
        }

        return matched;
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

        Walk(copy, Level.Top);
    }

    private enum Level
    {
        Nested,
        Top,
        Entity,
        Targets,
        Target,
    }

    /// <summary>
    /// Replaces matching values without recursion: nodes still to visit wait on an explicit stack, so any depth the size
    /// limit allows is redacted on any thread's stack. Each decision depends only on the node's own key and level, so the
    /// visiting order does not change the result.
    /// </summary>
    private void Walk(JsonNode? root, Level rootLevel)
    {
        var pending = new Stack<(JsonNode? Node, Level Level)>();
        pending.Push((root, rootLevel));
        while (pending.Count > 0)
        {
            var (node, level) = pending.Pop();
            switch (node)
            {
                case JsonObject obj:
                    foreach (var key in obj.Select(pair => pair.Key).ToList())
                    {
                        // Event identity and entity identifiers are structural: never replaced, whatever the pattern.
                        // Only "id" is exempt on actor, impersonator, executor and tenant; "type" and "id" only on targets.
                        if ((level == Level.Top && key is "id" or "action") || (level == Level.Entity && key == "id") || (level == Level.Target && key is "id" or "type"))
                        {
                            continue;
                        }

                        var child = level == Level.Top
                            ? key switch
                            {
                                "actor" or "impersonator" or "executor" or "tenant" => Level.Entity,
                                "targets" => Level.Targets,
                                _ => Level.Nested,
                            }
                            : Level.Nested;
                        if (child == Level.Nested && _keys.IsMatch(key))
                        {
                            obj[key] = _replacement;
                        }
                        else
                        {
                            pending.Push((obj[key], child));
                        }
                    }

                    break;
                case JsonArray array:
                    // JavaScript walks arrays by index keys ("0", "1", ...); match them the same way. Target entries are
                    // entities: never replaced as a whole, and their type and id are kept.
                    for (var i = 0; i < array.Count; i++)
                    {
                        if (level == Level.Targets)
                        {
                            pending.Push((array[i], Level.Target));
                        }
                        else if (_keys.IsMatch(i.ToString(CultureInfo.InvariantCulture)))
                        {
                            array[i] = _replacement;
                        }
                        else
                        {
                            pending.Push((array[i], Level.Nested));
                        }
                    }

                    break;
            }
        }
    }

    // JavaScript's RegExp.test coerces a non-string field to text.
    private static string FieldText(JsonNode? field)
        => field switch
        {
            null => "null",
            JsonValue value when Internal.JsJson.TryGetString(value, out var text) => text,
            _ => field.ToJsonString(),
        };
}
