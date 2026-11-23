using System.Text.Json.Nodes;
using Logbird.Internal;

namespace Logbird;

/// <summary>
/// One field's value before and after a change. Values are JSON: strings, numbers and booleans convert implicitly,
/// so <c>new AuditChange("status", "draft", "sent")</c> and <c>new AuditChange("limit", 24, 48)</c> both work.
/// Only record values you are allowed to store; redaction replaces values of sensitive fields.
/// </summary>
public sealed class AuditChange
{
    /// <summary>Records that <paramref name="field"/> changed from <paramref name="before"/> to <paramref name="after"/>. A <see langword="null"/> value is stored as JSON null.</summary>
    /// <param name="field">The field name, for example <c>status</c>.</param>
    /// <param name="before">The previous value.</param>
    /// <param name="after">The new value.</param>
    public AuditChange(string field, JsonNode? before, JsonNode? after)
        : this(field, before, hasBefore: true, after, hasAfter: true)
    {
    }

    private AuditChange(string field, JsonNode? before, bool hasBefore, JsonNode? after, bool hasAfter)
    {
        Field = Guard.NotNull(field, nameof(field));
        Before = before;
        HasBefore = hasBefore;
        After = after;
        HasAfter = hasAfter;
    }

    /// <summary>The field name.</summary>
    public string Field { get; }

    /// <summary>The previous value. Check <see cref="HasBefore"/> to tell "no previous value" from JSON null.</summary>
    public JsonNode? Before { get; }

    /// <summary>The new value. Check <see cref="HasAfter"/> to tell "no new value" from JSON null.</summary>
    public JsonNode? After { get; }

    /// <summary>Whether a previous value is recorded. <see langword="false"/> for a field that was just set.</summary>
    public bool HasBefore { get; }

    /// <summary>Whether a new value is recorded. <see langword="false"/> for a field that was removed.</summary>
    public bool HasAfter { get; }

    internal AuditChange DeepClone() => new(Field, Internal.JsonTree.Clone(Before), HasBefore, Internal.JsonTree.Clone(After), HasAfter);

    /// <summary>Records a field that was set for the first time, for example on a created record.</summary>
    /// <param name="field">The field name.</param>
    /// <param name="after">The new value.</param>
    public static AuditChange Set(string field, JsonNode? after) => new(field, null, hasBefore: false, after, hasAfter: true);

    /// <summary>Records a field that was removed, for example on a deleted record.</summary>
    /// <param name="field">The field name.</param>
    /// <param name="before">The previous value.</param>
    public static AuditChange Removed(string field, JsonNode? before) => new(field, before, hasBefore: true, null, hasAfter: false);

    /// <summary>Records that a secret changed without storing either value: both sides are <c>[redacted]</c>.</summary>
    /// <param name="field">The field name, for example <c>password</c>.</param>
    public static AuditChange Secret(string field) => new(field, "[redacted]", "[redacted]");
}
