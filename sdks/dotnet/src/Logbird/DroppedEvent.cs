using System;
using System.Text;

namespace Logbird;

/// <summary>Why an event will not be stored.</summary>
public enum DropReason
{
    /// <summary>The in-memory queue was full (see <see cref="LogbirdOptions.MaxQueueSize"/>).</summary>
    QueueFull = 0,

    /// <summary>The server rejected this event; see <see cref="DroppedEvent.Detail"/> for its reason. Other events in the batch are unaffected.</summary>
    Rejected = 1,

    /// <summary>The server answered a permanent HTTP error (a 4xx other than 429), for example an invalid key.</summary>
    HttpError = 2,

    /// <summary>The serialized event is larger than 256 KB.</summary>
    TooLarge = 3,

    /// <summary>The client was disposed and its shutdown timeout ran out before the event was sent.</summary>
    Shutdown = 4,

    /// <summary>The event could not be prepared, for example because <see cref="LogbirdOptions.BeforeSend"/> threw.</summary>
    Invalid = 5,

    /// <summary>
    /// An entity identifier cannot be stored exactly as sent (<c>invalid_entity_id</c>): an actor, impersonator,
    /// executor or tenant id or a target id longer than 256 UTF-16 code units, a target type longer than 64, a lone
    /// surrogate, or more than 256 targets. Checked before sending, with the same rule as the server.
    /// </summary>
    InvalidEntityId = 6,

    /// <summary>
    /// The server (or something in front of it) answered with success but without acknowledging the event, and it was
    /// still unacknowledged after the retry budget. It is not counted as delivered.
    /// </summary>
    Unacknowledged = 7,
}

/// <summary>An event that will not be stored, passed to <see cref="LogbirdOptions.OnDrop"/>.</summary>
public sealed class DroppedEvent
{
    private readonly byte[]? _json;

    internal DroppedEvent(DropReason reason, string? id, string action, byte[]? json, string? detail)
    {
        Reason = reason;
        Id = id;
        Action = action;
        _json = json;
        Detail = detail;
    }

    /// <summary>Why the event was dropped.</summary>
    public DropReason Reason { get; }

    /// <summary>The event id, when one was assigned.</summary>
    public string? Id { get; }

    /// <summary>The event action.</summary>
    public string Action { get; }

    /// <summary>The server's reason for a <see cref="DropReason.Rejected"/> event, or another short explanation.</summary>
    public string? Detail { get; }

    /// <summary>
    /// The exact JSON that was (or would have been) sent, as UTF-8, after redaction. Empty when the event was dropped
    /// before it was serialized. Persist it to replay the event later with the same id.
    /// </summary>
    public ReadOnlyMemory<byte> Json => _json ?? ReadOnlyMemory<byte>.Empty;

    /// <summary>The JSON as a string.</summary>
    public string JsonText => _json is null ? string.Empty : Encoding.UTF8.GetString(_json);
}

/// <summary>A snapshot of a client's counters since it was created.</summary>
/// <param name="Tracked">Events accepted into the queue.</param>
/// <param name="Delivered">Events the server stored (or already had, for a retry).</param>
/// <param name="Rejected">Events the server rejected individually.</param>
/// <param name="Dropped">Events dropped for any other reason (queue full, permanent HTTP error, too large, invalid, shutdown).</param>
/// <param name="Filtered">Events <see cref="LogbirdOptions.BeforeSend"/> chose to skip.</param>
/// <param name="FailedSends">Batches that failed after all retries and went back to the queue.</param>
/// <param name="QueueLength">Events currently waiting, including a batch being sent.</param>
/// <param name="Warnings">Warnings about stored events: surrounding whitespace in an identifier, or a server warning such as an adjusted timestamp.</param>
public readonly record struct LogbirdStats(
    long Tracked,
    long Delivered,
    long Rejected,
    long Dropped,
    long Filtered,
    long FailedSends,
    int QueueLength,
    long Warnings = 0);
