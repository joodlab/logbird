using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Logbird;

/// <summary>An event as Logbird stored and normalized it. Missing text fields are empty strings.</summary>
public sealed class StoredEvent
{
    /// <summary>The event id.</summary>
    [JsonRequired]
    public string Id { get; init; } = string.Empty;

    /// <summary>The project the event belongs to.</summary>
    [JsonRequired]
    public string ProjectId { get; init; } = string.Empty;

    /// <summary>When it happened (UTC, millisecond precision).</summary>
    [JsonRequired]
    public DateTimeOffset Timestamp { get; init; }

    /// <summary>When Logbird received it.</summary>
    public DateTimeOffset ReceivedAt { get; init; }

    /// <summary>The environment.</summary>
    public string Environment { get; init; } = string.Empty;

    /// <summary>The action, for example <c>invoice.updated</c>.</summary>
    [JsonRequired]
    public string Action { get; init; } = string.Empty;

    /// <summary>The first segment of the action, for example <c>invoice</c>.</summary>
    public string Category { get; init; } = string.Empty;

    /// <summary>The outcome.</summary>
    public string Outcome { get; init; } = string.Empty;

    /// <summary>The severity.</summary>
    public string Severity { get; init; } = string.Empty;

    /// <summary>The description.</summary>
    public string Description { get; init; } = string.Empty;

    /// <summary>Who caused it, or <see langword="null"/>.</summary>
    public AuditActor? Actor { get; init; }

    /// <summary>The impersonator, or <see langword="null"/>.</summary>
    public AuditImpersonator? Impersonator { get; init; }

    /// <summary>What performed it, or <see langword="null"/>.</summary>
    public AuditExecutor? Executor { get; init; }

    /// <summary>The tenant, or <see langword="null"/>.</summary>
    public AuditTenant? Tenant { get; init; }

    /// <summary>The upstream source, or <see langword="null"/>.</summary>
    public string? Source { get; init; }

    /// <summary>The affected records. Read-only: a copy, which a cast cannot change.</summary>
    public IReadOnlyList<AuditTarget> Targets { get => _targets; init => _targets = Internal.ReadOnly.List(value); }

    private readonly IReadOnlyList<AuditTarget> _targets = Internal.ReadOnly.List<AuditTarget>(null);

    /// <summary>The recorded changes. Non-string values are stored as JSON text. Read-only, like <see cref="Targets"/>.</summary>
    public IReadOnlyList<StoredChange> Changes { get => _changes; init => _changes = Internal.ReadOnly.List(value); }

    private readonly IReadOnlyList<StoredChange> _changes = Internal.ReadOnly.List<StoredChange>(null);

    /// <summary>Correlation and request details.</summary>
    public AuditContext Context { get; init; } = new();

    /// <summary>
    /// Flattened extra fields, for example <c>metadata.plan</c>. Read-only, like <see cref="Targets"/>. Keys are compared
    /// ordinally (as Logbird stores them); a <see cref="Dictionary{TKey, TValue}"/> you pass keeps its own comparer.
    /// </summary>
    public IReadOnlyDictionary<string, string> Attributes { get => _attributes; init => _attributes = Internal.ReadOnly.Dictionary(value); }

    private readonly IReadOnlyDictionary<string, string> _attributes = Internal.ReadOnly.Dictionary(null);

    /// <summary>The share (0 to 100) of recommended envelope fields present.</summary>
    public double Conformance { get; init; }

    /// <summary>The envelope schema version.</summary>
    public string SchemaVersion { get; init; } = string.Empty;

    /// <summary>The SDK that sent the event, for example <c>dotnet/0.1.0</c>.</summary>
    public string Sdk { get; init; } = string.Empty;
}

/// <summary>A stored before/after change. Values are text; numbers and objects arrive as their JSON.</summary>
/// <param name="Field">The field name.</param>
/// <param name="Before">The previous value.</param>
/// <param name="After">The new value.</param>
/// <remarks>
/// Its <c>ToString()</c> lists no values, so writing it as text cannot leak them. A structured logger that serializes its
/// properties still sees them.
/// </remarks>
public sealed record StoredChange(string Field, string Before, string After)
{
    /// <summary>
    /// <c>ToString()</c> lists no values (not even the field name), so writing this object as text cannot leak anything. A structured logger that serializes its properties still sees them.
    /// </summary>
#pragma warning disable CA1822 // The compiler-generated record ToString calls this instance member by name.
    private bool PrintMembers(System.Text.StringBuilder builder)
    {
        _ = builder;
        return false;
    }
#pragma warning restore CA1822
}

/// <summary>One page of search results.</summary>
public sealed class EventPage
{
    /// <summary>The events on this page. Read-only: a copy, which a cast cannot change.</summary>
    [JsonPropertyName("data")]
    [JsonRequired]
    public IReadOnlyList<StoredEvent> Events { get => _events; init => _events = Internal.ReadOnly.List(value); }

    private readonly IReadOnlyList<StoredEvent> _events = Internal.ReadOnly.List<StoredEvent>(null);

    /// <summary>The cursor for the next page, or <see langword="null"/> on the last page.</summary>
    public string? NextCursor { get; init; }

    /// <summary>The number of matches in the range. It may be capped or estimated for very large ranges; see <see cref="TotalExact"/>.</summary>
    public long Total { get; init; }

    /// <summary>
    /// <see langword="false"/> when <see cref="Total"/> is only a lower bound, <see langword="true"/> when it is exact,
    /// and <see langword="null"/> when the server does not say (older servers).
    /// </summary>
    public bool? TotalExact { get; init; }

    /// <summary>
    /// The time window the server applied, or <see langword="null"/> when the server does not say (older servers).
    /// Without <see cref="EventSearch.From"/> the server reads only the 24 hours before the end, so compare this with
    /// the window you meant before you treat a page as a complete history.
    /// </summary>
    public EventRange? Range { get; init; }

    /// <summary>How long the query took on the server, in milliseconds.</summary>
    public double TookMs { get; init; }
}

/// <summary>
/// The time window a read applied: events whose timestamp is at or after <see cref="From"/> and before
/// <see cref="To"/>, as ISO 8601 UTC text with milliseconds, exactly as the server sent it.
/// </summary>
public sealed class EventRange
{
    /// <summary>The inclusive start: the requested start, or the end minus 24 hours when none was given.</summary>
    public string From { get; init; } = string.Empty;

    /// <summary>The exclusive end: the requested end, or the server clock when none was given.</summary>
    public string To { get; init; } = string.Empty;
}

/// <summary>One event with its raw payload and causation context.</summary>
public sealed class EventDetail
{
    /// <summary>The normalized event.</summary>
    [JsonRequired]
    public StoredEvent Event { get; init; } = new();

    /// <summary>The raw JSON exactly as Logbird received it (after client-side redaction).</summary>
    [JsonRequired]
    public JsonElement Payload { get; init; }

    /// <summary>The causation chain, from the root to the direct parent. Read-only: a copy, which a cast cannot change.</summary>
    public IReadOnlyList<StoredEvent> Parents { get => _parents; init => _parents = Internal.ReadOnly.List(value); }

    private readonly IReadOnlyList<StoredEvent> _parents = Internal.ReadOnly.List<StoredEvent>(null);

    /// <summary>How many events name this one as their parent.</summary>
    public long ChildCount { get; init; }

    /// <summary>How many events share this event's operation id.</summary>
    public long OperationSize { get; init; }
}

// A stored payload may nest as deep as the SDK sends (1,000 levels in metadata) inside the detail envelope, beyond the
// reader's default of 64.
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, MaxDepth = ReadDepth.Max)]
[JsonSerializable(typeof(EventPage))]
[JsonSerializable(typeof(EventDetail))]
internal sealed partial class ReadJsonContext : JsonSerializerContext
{
}

/// <summary>How deep a read answer may nest: a stored payload at the send limit plus the detail and page envelopes.</summary>
internal static class ReadDepth
{
    public const int Max = Internal.JsonSize.MaxEventJson + 16;
}
