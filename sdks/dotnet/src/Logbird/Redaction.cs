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
/// <para>
/// A key matches when the pattern matches any part of it: the default redacts <c>tokenCount</c> and <c>secretary</c> as
/// well as <c>token</c> and <c>secret</c>. Anchor a pattern of your own (<c>^name$</c>) to match whole keys only. A
/// matching key keeps its name and its value becomes <see cref="Replacement"/>, at any depth (actor, targets, context,
/// metadata). For a change whose <c>field</c> matches <see cref="ChangeFields"/>, the recorded before and after values are
/// replaced.
/// </para>
/// <para>
/// Identity is never redacted: the top-level <c>id</c> and <c>action</c>, and <see cref="Redactor.IdentifierFields"/>.
/// A pattern that matches a party's own key (<c>actor</c>, <c>impersonator</c>, <c>executor</c>, <c>tenant</c> or
/// <c>targets</c>) redacts every other field of that party (its name, email and any extra field) and keeps its
/// identifier fields; the party is never replaced as a whole; so does a pattern matching a target's index. A change's
/// values are replaced when its <c>field</c> is a string <see cref="ChangeFields"/> matches.
/// </para>
/// <para>
/// The TypeScript SDK's <c>redact()</c> follows the same rules, checked against one shared fixture: with the default
/// pattern, and names added with <see cref="AddKeys"/>, both redact exactly the same keys. A pattern of your own runs on
/// each platform's regular-expression engine, which can differ at the edges (in .NET, <c>$</c> also matches before a
/// final line feed, so use <c>\z</c> for "end of key"; case-insensitive options fold case differently), so keep custom
/// patterns to what means the same in both. <see cref="Redactor.Redact"/> accepts event JSON up to 1,008 levels deep.
/// </para>
/// <para>The default pattern does not cover personal data: add your own keys with <see cref="AddKeys"/>.</para>
/// </remarks>
public sealed class RedactionOptions
{
    /// <summary>Whether redaction runs. Defaults to <see langword="true"/>.</summary>
    public bool Enabled { get; set; } = true;

    private readonly List<string> _added = [];

    /// <summary>
    /// Object keys whose values are replaced, matched as substrings (see the remarks). Defaults to
    /// <see cref="Redactor.DefaultSecretKeys"/>. A pattern of your own is matched with the options you give it; the default
    /// ignores only ASCII letter case, as JavaScript's <c>/i</c> does here. Names added with <see cref="AddKeys"/> are
    /// matched in addition to this pattern, separately from it, so replacing it keeps them.
    /// </summary>
    public Regex Keys { get; set; } = Redactor.DefaultSecretKeys;

    /// <summary>
    /// The names <see cref="AddKeys"/> added, in order. A key is redacted when <see cref="Keys"/> or any of these names
    /// matches it.
    /// </summary>
    public IReadOnlyList<string> AddedKeys => Internal.ReadOnly.List(_added);

    /// <summary>
    /// Change fields whose before and after values are replaced. Defaults to <see cref="Keys"/> together with
    /// <see cref="AddedKeys"/>.
    /// </summary>
    public Regex? ChangeFields { get; set; }

    /// <summary>The replacement value. Defaults to <c>[redacted]</c>.</summary>
    public string Replacement { get; set; } = Redactor.DefaultReplacement;

    /// <summary>
    /// Adds key names to redact as well as <see cref="Keys"/>, for example <c>AddKeys("email", "phone")</c>. Names are
    /// matched as substrings, ignoring ASCII letter case only, like the default pattern (<c>Email</c> matches; a key
    /// spelled with a look-alike such as U+212A KELVIN SIGN does not, as in the TypeScript SDK). They are matched apart
    /// from <see cref="Keys"/>, which is left as it is, so nothing in that pattern (its options, an inline option or a
    /// trailing comment) changes how they match, and they do not change how it matches.
    /// </summary>
    /// <param name="names">Plain key names; they are escaped, not treated as patterns.</param>
    /// <returns>These options.</returns>
    public RedactionOptions AddKeys(params string[] names)
    {
        Guard.NotNull(names, nameof(names));
        foreach (var name in names)
        {
            Guard.NotNull(name, nameof(names));
        }

        _added.AddRange(names);
        return this;
    }

    internal Redactor? CreateRedactor()
        => Enabled ? new Redactor(Keys, ChangeFields, Replacement, AddedPattern()) : null;

    /// <summary>The added names as one pattern of their own, with the timeout of <see cref="Keys"/>; null when there are none.</summary>
    private Regex? AddedPattern()
        => _added.Count == 0
            ? null
            : new Regex(string.Join("|", _added.Select(Redactor.AsciiCaseless)), RegexOptions.CultureInvariant, Keys.MatchTimeout);
}

/// <summary>
/// Removes secrets from event JSON. The same rules as the TypeScript SDK's <c>redact()</c>, checked against one shared
/// fixture: works on a deep copy, keeps keys, replaces values whose key matches, replaces present before/after values of
/// matching change fields, and never redacts identity (see <see cref="RedactionOptions"/>).
/// </summary>
public sealed class Redactor
{
    /// <summary>The default replacement value.</summary>
    public const string DefaultReplacement = "[redacted]";

    /// <summary>
    /// The default secret key pattern: the TypeScript SDK's <c>DEFAULT_SECRET_KEYS</c>
    /// (<c>passw(or)?d|secret|token|otp|api[-_]?key|authorization|cookie|credential|private[-_]?key</c>, flag <c>i</c>), with each
    /// ASCII letter written as both its cases (<c>[pP][aA]…</c>) instead of a case-insensitive option. So it matches exactly
    /// the keys JavaScript's <c>/i</c> does, on every .NET runtime: ASCII case is ignored, and a look-alike such as U+212A
    /// KELVIN SIGN or U+017F LONG S is not taken for a letter of the pattern.
    /// </summary>
    public static readonly Regex DefaultSecretKeys = new(
        AsciiCaselessPattern("passw(or)?d|secret|token|otp|api[-_]?key|authorization|cookie|credential|private[-_]?key"),
        RegexOptions.CultureInvariant);

    /// <summary>A pattern's ASCII letters written as both cases; its other characters are kept (they are syntax here).</summary>
    private static string AsciiCaselessPattern(string pattern)
    {
        var text = new System.Text.StringBuilder(pattern.Length * 4);
        foreach (var c in pattern)
        {
            text.Append(c is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z') ? Letter(c) : c.ToString());
        }

        return text.ToString();
    }

    /// <summary>A plain name as a pattern: ASCII letters match either case, everything else literally.</summary>
    internal static string AsciiCaseless(string name)
    {
        Guard.NotNull(name, nameof(name));
        var text = new System.Text.StringBuilder(name.Length * 4);
        foreach (var c in name)
        {
            text.Append(c is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z') ? Letter(c) : Regex.Escape(c.ToString()));
        }

        return text.ToString();
    }

    private static string Letter(char c) => "[" + char.ToLowerInvariant(c) + char.ToUpperInvariant(c) + "]";

    private readonly Regex _keys;
    private readonly Regex? _added;
    private readonly Regex? _changeFields;
    private readonly string _replacement;

    /// <summary>Creates a redactor.</summary>
    /// <param name="keys">Key pattern; defaults to <see cref="DefaultSecretKeys"/>.</param>
    /// <param name="changeFields">Change field pattern; defaults to <paramref name="keys"/>.</param>
    /// <param name="replacement">Replacement value; defaults to <c>[redacted]</c>.</param>
    public Redactor(Regex? keys = null, Regex? changeFields = null, string? replacement = null)
    {
        _keys = keys ?? DefaultSecretKeys;
        _changeFields = changeFields;
        _replacement = replacement ?? DefaultReplacement;
    }

    /// <summary>A redactor that also matches the names <see cref="RedactionOptions.AddKeys"/> added, as their own pattern.</summary>
    internal Redactor(Regex? keys, Regex? changeFields, string? replacement, Regex? added)
        : this(keys, changeFields, replacement)
    {
        _added = added;
    }

    internal bool IsKey(string key) => _keys.IsMatch(key) || (_added?.IsMatch(key) ?? false);

    private bool IsChangeField(string field) => _changeFields?.IsMatch(field) ?? IsKey(field);

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
    /// Fields that identify and classify the parties. They are never redacted, whatever the pattern: a redacted id would
    /// merge every identity into one, and an executor's attempt must stay a number. To pseudonymise an id, transform it
    /// before recording.
    /// </summary>
    public static IReadOnlyList<string> IdentifierFields { get; } =
        ["actor.type", "actor.id", "impersonator.id", "executor.type", "executor.id", "executor.jobId", "executor.attempt", "tenant.id", "targets[].type", "targets[].id"];

    // The names of the fields never redacted (identifier fields and the event's action), checked at startup: a pattern
    // matching one is reported once.
    private static readonly string[] StructuralKeys = ["id", "action", "type", "jobId", "attempt"];

    /// <summary>The identifier-related keys this redactor's patterns would match (they are exempt from redaction).</summary>
    internal List<string> IdentifierFieldsMatched()
    {
        var matched = new List<string>();
        foreach (var key in StructuralKeys)
        {
            try
            {
                if (IsKey(key))
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
                // Only an object entry whose field is a string is matched; any other shape is left to the walk.
                if (item is not JsonObject change || !IsText(change["field"], out var field) || !IsChangeField(field))
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
        Actor,
        Impersonator,
        Executor,
        Tenant,
        Targets,
        Target,
    }

    /// <summary>Whether <paramref name="key"/> is an identifier field of a party at <paramref name="level"/>.</summary>
    private static bool IsIdentity(Level level, string key) => level switch
    {
        Level.Top => key is "id" or "action",
        Level.Actor => key is "id" or "type",
        Level.Impersonator or Level.Tenant => key == "id",
        Level.Executor => key is "id" or "type" or "jobId" or "attempt",
        Level.Target => key is "id" or "type",
        _ => false,
    };

    private static Level PartyLevel(string key) => key switch
    {
        "actor" => Level.Actor,
        "impersonator" => Level.Impersonator,
        "executor" => Level.Executor,
        "tenant" => Level.Tenant,
        "targets" => Level.Targets,
        _ => Level.Nested,
    };

    /// <summary>
    /// Replaces matching values without recursion: nodes still to visit wait on an explicit stack, so any depth the size
    /// limit allows is redacted on any thread's stack. Each decision depends only on the node's own key and level, so the
    /// visiting order does not change the result.
    /// </summary>
    private void Walk(JsonNode? root, Level rootLevel)
    {
        // Whole: the party's own key matched, so every field of it other than its identifier fields is replaced.
        var pending = new Stack<(JsonNode? Node, Level Level, bool Whole)>();
        pending.Push((root, rootLevel, false));
        while (pending.Count > 0)
        {
            var (node, level, whole) = pending.Pop();
            switch (node)
            {
                case JsonObject obj:
                    foreach (var key in obj.Select(pair => pair.Key).ToList())
                    {
                        // Event identity and the parties' identifier fields are structural: never replaced.
                        if (IsIdentity(level, key))
                        {
                            continue;
                        }

                        if (whole)
                        {
                            obj[key] = _replacement;
                            continue;
                        }

                        var party = level == Level.Top ? PartyLevel(key) : Level.Nested;
                        var matched = IsKey(key);
                        var value = obj[key];
                        if (party != Level.Nested && (party == Level.Targets ? value is JsonArray : value is JsonObject))
                        {
                            // A party is never replaced as a whole; a match redacts everything but its identity.
                            pending.Push((value, party, matched));
                        }
                        else if (matched)
                        {
                            obj[key] = _replacement;
                        }
                        else
                        {
                            pending.Push((value, Level.Nested, false));
                        }
                    }

                    break;
                case JsonArray array:
                    // JavaScript walks arrays by index keys ("0", "1", ...); match them the same way. Target entries are
                    // parties: never replaced as a whole, and their type and id are kept; a pattern matching an entry's
                    // index (or the targets key) redacts the entry's other fields, and a scalar entry is replaced.
                    for (var i = 0; i < array.Count; i++)
                    {
                        if (level == Level.Targets)
                        {
                            var entryMatched = whole || IsKey(i.ToString(CultureInfo.InvariantCulture));
                            if (array[i] is JsonObject)
                            {
                                pending.Push((array[i], Level.Target, entryMatched));
                            }
                            else if (entryMatched)
                            {
                                array[i] = _replacement;
                            }
                            else
                            {
                                pending.Push((array[i], Level.Nested, false));
                            }
                        }
                        else if (IsKey(i.ToString(CultureInfo.InvariantCulture)))
                        {
                            array[i] = _replacement;
                        }
                        else
                        {
                            pending.Push((array[i], Level.Nested, false));
                        }
                    }

                    break;
            }
        }
    }

    private static bool IsText(JsonNode? field, out string text)
    {
        if (field is JsonValue value && Internal.JsJson.TryGetString(value, out var found))
        {
            text = found;
            return true;
        }

        text = string.Empty;
        return false;
    }
}
