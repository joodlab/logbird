using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;
using Logbird.Internal;

namespace Logbird;

/// <summary>
/// One audit event: who (<see cref="Actor"/>) did what (<see cref="Action"/>) to which records (<see cref="Targets"/>).
/// Only <see cref="Action"/> is required.
/// </summary>
/// <example>
/// <code>
/// client.Track(new AuditEvent("invoice.updated")
/// {
///     Actor = AuditActor.User("user_42", name: "Lina Haddad"),
///     Tenant = new AuditTenant("acct_7"),
///     Targets = { new AuditTarget("invoice", "inv_1001") { Name = "INV-1001" } },
///     Changes = { new AuditChange("status", "draft", "sent") },
/// });
/// </code>
/// </example>
public sealed class AuditEvent
{
    private IList<AuditTarget>? _targets;
    private IList<AuditChange>? _changes;
    private bool _targetsAssigned;
    private bool _changesAssigned;
    private AuditContext? _context;
    private JsonObject? _metadata;

    /// <summary>Creates an event for <paramref name="action"/>.</summary>
    /// <param name="action">A stable, dot-separated name for what happened, for example <c>invoice.updated</c>.</param>
    public AuditEvent(string action)
    {
        Action = Guard.NotNull(action, nameof(action));
    }

    /// <summary>A stable, dot-separated name for what happened: <c>&lt;entity&gt;.&lt;verb&gt;</c>, for example <c>invoice.updated</c>.</summary>
    public string Action { get; set; }

    /// <summary>
    /// The event id. Leave it empty and the client assigns a UUIDv7 when you call <c>Track</c>. Set it yourself
    /// (see <see cref="LogbirdClient.NewEventId"/>) when you persist events for replay: Logbird stores one event per id,
    /// so sending the same event again never creates a duplicate.
    /// </summary>
    public string? Id { get; set; }

    /// <summary>When it happened. Defaults to the time <c>Track</c> was called.</summary>
    public DateTimeOffset? OccurredAt { get; set; }

    /// <summary>The deployment environment, for example <c>production</c>. Defaults to <see cref="LogbirdOptions.Environment"/>.</summary>
    public string? Environment { get; set; }

    /// <summary>The result: <c>success</c>, <c>failure</c>, <c>denied</c>, <c>partial</c> or <c>unknown</c>. See <see cref="AuditOutcome"/>.</summary>
    public string? Outcome { get; set; }

    /// <summary>The importance: <c>info</c>, <c>notice</c>, <c>warning</c> or <c>critical</c>. See <see cref="AuditSeverity"/>.</summary>
    public string? Severity { get; set; }

    /// <summary>A human-readable sentence, for example "Lina changed the status of INV-1001".</summary>
    public string? Description { get; set; }

    /// <summary>Who caused the event.</summary>
    public AuditActor? Actor { get; set; }

    /// <summary>Who really operated the session when acting on behalf of <see cref="Actor"/>.</summary>
    public AuditImpersonator? Impersonator { get; set; }

    /// <summary>What performed the change (API, worker, job attempt).</summary>
    public AuditExecutor? Executor { get; set; }

    /// <summary>The business scope, such as a customer account.</summary>
    public AuditTenant? Tenant { get; set; }

    /// <summary>The upstream system that supplied the change, if any. Defaults to <see cref="LogbirdOptions.Source"/>.</summary>
    public string? Source { get; set; }

    /// <summary>The envelope schema version. Leave empty unless you know you need it.</summary>
    public string? SchemaVersion { get; set; }

    /// <summary>
    /// The records the event affected. Add to it, or assign a list; an assigned empty list is sent as <c>[]</c>, while
    /// an untouched one is omitted (this matters only for replaying an event first sent by another SDK).
    /// </summary>
    public IList<AuditTarget> Targets
    {
        get => _targets ??= new List<AuditTarget>();
        set
        {
            _targets = value;
            _targetsAssigned = value is not null;
        }
    }

    /// <summary>
    /// The before and after values that are allowed to be stored. Add to it, or assign a list; an assigned empty list
    /// is sent as <c>[]</c>, while an untouched one is omitted.
    /// </summary>
    public IList<AuditChange> Changes
    {
        get => _changes ??= new List<AuditChange>();
        set
        {
            _changes = value;
            _changesAssigned = value is not null;
        }
    }

    /// <summary>Correlation and request details.</summary>
    public AuditContext Context
    {
        get => _context ??= new AuditContext();
        set => _context = value;
    }

    /// <summary>Any extra JSON data. Logbird flattens it into searchable attributes such as <c>metadata.plan</c>.</summary>
    public JsonObject Metadata
    {
        get => _metadata ??= [];
        set => _metadata = value;
    }

    internal bool EmitTargets => _targets is { Count: > 0 } || (_targetsAssigned && _targets is not null);

    internal bool EmitChanges => _changes is { Count: > 0 } || (_changesAssigned && _changes is not null);

    internal AuditContext? ContextOrNull => _context;

    internal JsonObject? MetadataOrNull => _metadata;

    /// <summary>Adds a target and returns this event.</summary>
    /// <param name="type">The record type, for example <c>invoice</c>.</param>
    /// <param name="id">The record id.</param>
    /// <param name="name">An optional safe display name.</param>
    public AuditEvent Target(string type, string id, string? name = null)
    {
        Targets.Add(new AuditTarget(type, id) { Name = name });
        return this;
    }

    /// <summary>Adds a before/after change and returns this event.</summary>
    /// <param name="field">The field name.</param>
    /// <param name="before">The previous value.</param>
    /// <param name="after">The new value.</param>
    public AuditEvent Change(string field, JsonNode? before, JsonNode? after)
    {
        Changes.Add(new AuditChange(field, before, after));
        return this;
    }

    /// <summary>Sets a metadata value and returns this event.</summary>
    /// <param name="key">The metadata key.</param>
    /// <param name="value">The JSON value; strings, numbers and booleans convert implicitly.</param>
    public AuditEvent WithMetadata(string key, JsonNode? value)
    {
        Metadata[key] = value;
        return this;
    }

    /// <summary>Creates a copy whose lists, context and metadata can be changed without affecting this event.</summary>
    /// <exception cref="InvalidOperationException">Metadata or a change value nests JSON deeper than 1,000 levels.</exception>
    public AuditEvent Clone()
    {
        if (JsonSize.Exceeds(this))
        {
            throw new InvalidOperationException($"The event nests JSON deeper than {JsonSize.Max} levels.");
        }

        var copy = (AuditEvent)MemberwiseClone();
        copy._targets = _targets is null ? null : new List<AuditTarget>(_targets);
        copy._changes = _changes is null ? null : _changes.Select(change => change?.DeepClone()!).ToList();
        copy._context = _context?.Clone();
        copy._metadata = (JsonObject?)JsonTree.Clone(_metadata);
        return copy;
    }
}

/// <summary>Well-known values for <see cref="AuditEvent.Outcome"/>. Any other string is stored as sent.</summary>
public static class AuditOutcome
{
    /// <summary>The operation succeeded.</summary>
    public const string Success = "success";

    /// <summary>The operation failed.</summary>
    public const string Failure = "failure";

    /// <summary>Access was denied.</summary>
    public const string Denied = "denied";

    /// <summary>The operation partly succeeded.</summary>
    public const string Partial = "partial";

    /// <summary>The result is not known.</summary>
    public const string Unknown = "unknown";
}

/// <summary>Well-known values for <see cref="AuditEvent.Severity"/>. Any other string is stored as sent.</summary>
public static class AuditSeverity
{
    /// <summary>Routine activity.</summary>
    public const string Info = "info";

    /// <summary>Worth noticing.</summary>
    public const string Notice = "notice";

    /// <summary>Potentially harmful.</summary>
    public const string Warning = "warning";

    /// <summary>Needs immediate attention.</summary>
    public const string Critical = "critical";
}
