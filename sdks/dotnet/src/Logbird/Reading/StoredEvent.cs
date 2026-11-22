using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Logbird;

/// <summary>An event as Logbird stored and normalized it. Missing text fields are empty strings.</summary>
public sealed class StoredEvent
{
    /// <summary>The event id.</summary>
    public string Id { get; init; } = string.Empty;

    /// <summary>The project the event belongs to.</summary>
    public string ProjectId { get; init; } = string.Empty;

    /// <summary>When it happened (UTC, millisecond precision).</summary>
    public DateTimeOffset Timestamp { get; init; }

    /// <summary>When Logbird received it.</summary>
    public DateTimeOffset ReceivedAt { get; init; }

    /// <summary>The environment.</summary>
    public string Environment { get; init; } = string.Empty;

    /// <summary>The action, for example <c>invoice.updated</c>.</summary>
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

    /// <summary>The affected records.</summary>
    public IReadOnlyList<AuditTarget> Targets { get; init; } = [];

    /// <summary>The recorded changes. Non-string values are stored as JSON text.</summary>
    public IReadOnlyList<StoredChange> Changes { get; init; } = [];

    /// <summary>Correlation and request details.</summary>
    public AuditContext Context { get; init; } = new();

    /// <summary>Flattened extra fields, for example <c>metadata.plan</c>.</summary>
    public IReadOnlyDictionary<string, string> Attributes { get; init; } = new Dictionary<string, string>();

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
public sealed record StoredChange(string Field, string Before, string After)
{
    /// <summary>Lists only the field name, never the values, so logging this object cannot leak them.</summary>
    private bool PrintMembers(System.Text.StringBuilder builder)
    {
        builder.Append("Field = ").Append(Field);
        return true;
    }
}

/// <summary>One page of search results.</summary>
public sealed class EventPage
{
    /// <summary>The events on this page.</summary>
    [JsonPropertyName("data")]
    public IReadOnlyList<StoredEvent> Events { get; init; } = [];

    /// <summary>The cursor for the next page, or <see langword="null"/> on the last page.</summary>
    public string? NextCursor { get; init; }

    /// <summary>The number of matches in the range. It may be capped or estimated for very large ranges; see <see cref="TotalExact"/>.</summary>
    public long Total { get; init; }

    /// <summary>
    /// <see langword="false"/> when <see cref="Total"/> is only a lower bound, <see langword="true"/> when it is exact,
    /// and <see langword="null"/> when the server does not say (older servers).
    /// </summary>
    public bool? TotalExact { get; init; }

    /// <summary>How long the query took on the server, in milliseconds.</summary>
    public double TookMs { get; init; }
}

/// <summary>One event with its raw payload and causation context.</summary>
public sealed class EventDetail
{
    /// <summary>The normalized event.</summary>
    public StoredEvent Event { get; init; } = new();

    /// <summary>The raw JSON exactly as Logbird received it (after client-side redaction).</summary>
    public JsonElement Payload { get; init; }

    /// <summary>The causation chain, from the root to the direct parent.</summary>
    public IReadOnlyList<StoredEvent> Parents { get; init; } = [];

    /// <summary>How many events name this one as their parent.</summary>
    public long ChildCount { get; init; }

    /// <summary>How many events share this event's operation id.</summary>
    public long OperationSize { get; init; }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(EventPage))]
[JsonSerializable(typeof(EventDetail))]
internal sealed partial class ReadJsonContext : JsonSerializerContext
{
}
