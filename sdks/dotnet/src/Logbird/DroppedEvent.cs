using System;
using System.Text;

namespace Logbird;

/// <summary>
/// Why the SDK stopped trying to deliver an event. A dropped event is not always absent from the audit log: see
/// <see cref="DroppedEvent.MayBeStored"/>.
/// </summary>
public enum DropReason
{
    /// <summary>The in-memory queue was full (see <see cref="LogbirdOptions.MaxQueueSize"/>).</summary>
    QueueFull = 0,

    /// <summary>The server rejected this event; see <see cref="DroppedEvent.Code"/> for its code and <see cref="DroppedEvent.Detail"/> for its reason. Other events in the batch are unaffected.</summary>
    Rejected = 1,

    /// <summary>The server answered a permanent HTTP error (a 4xx other than 429), for example an invalid key.</summary>
    HttpError = 2,

    /// <summary>The serialized event is larger than 256 KB.</summary>
    TooLarge = 3,

    /// <summary>
    /// The client shut down before delivery was confirmed: its shutdown timeout (or the host's budget) ran out with the
    /// event queued or in flight, or the event was tracked after shutdown began. An event in flight may have been stored;
    /// see <see cref="DroppedEvent.MayBeStored"/>.
    /// </summary>
    Shutdown = 4,

    /// <summary>The event could not be prepared, for example because <see cref="LogbirdOptions.BeforeSend"/> threw.</summary>
    Invalid = 5,

    // 6 is not used: it was an SDK-side identifier refusal, removed before the first release. The SDK sends identifiers
    // exactly as given and the server decides; a server rejection is Rejected, with the server's code in DroppedEvent.Code.

    /// <summary>
    /// The server (or something in front of it) answered with success but without acknowledging the event, and it was
    /// still unacknowledged after the retry budget. It is not counted as delivered.
    /// </summary>
    Unacknowledged = 7,
}

/// <summary>
/// An event the SDK stopped trying to deliver, passed to <see cref="LogbirdOptions.OnDrop"/>. Whether the server may
/// still have stored it is <see cref="MayBeStored"/>.
/// </summary>
public sealed class DroppedEvent
{
    private readonly byte[]? _json;

    internal DroppedEvent(DropReason reason, string? id, string action, byte[]? json, string? detail, string? code = null, bool mayBeStored = false)
    {
        Reason = reason;
        Id = id;
        Action = action;
        _json = json;
        Detail = detail;
        Code = code;
        MayBeStored = mayBeStored;
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
    /// The server's code for a <see cref="DropReason.Rejected"/> event, for example <c>invalid_event</c> or
    /// <c>invalid_entity_id</c>; <c>other</c> for a code this SDK does not know. Null for every other reason.
    /// </summary>
    public string? Code { get; }

    /// <summary>
    /// Whether the server may have stored this event even though the SDK dropped it. True when the event was put on the
    /// wire at least once and no answer settled it: a request ended without an answer, or with a 5xx, or with a success
    /// that did not acknowledge it, or it was still in flight at shutdown. False when the event was never sent, or every
    /// answer for it said it was not stored (<see cref="DropReason.Rejected"/>, <see cref="DropReason.TooLarge"/> and
    /// <see cref="DropReason.Invalid"/> are always false). A "dropped" event is not necessarily absent: when this is true,
    /// resend <see cref="Json"/> (the server deduplicates by id) or look the id up before treating the event as lost.
    /// </summary>
    public bool MayBeStored { get; }

    /// <summary>
    /// The exact JSON that was (or would have been) sent, as UTF-8, after redaction. Empty when the event was dropped
    /// before it was serialized. Persist it to replay the event later with the same id.
    /// </summary>
    public ReadOnlyMemory<byte> Json => _json ?? ReadOnlyMemory<byte>.Empty;

    /// <summary>The JSON as a string.</summary>
    public string JsonText => _json is null ? string.Empty : Encoding.UTF8.GetString(_json);
}

/// <summary>
/// A snapshot of a client's counters since it was created. Unlike the event records, its <c>ToString()</c> prints its
/// values on purpose: they are counts only and carry no event, identity or query data.
/// </summary>
/// <param name="Tracked">Events accepted into the queue.</param>
/// <param name="Delivered">Events the server stored (or already had, for a retry).</param>
/// <param name="Rejected">Events the server rejected individually.</param>
/// <param name="Dropped">Events dropped for any other reason (queue full, permanent HTTP error, too large, invalid, shutdown).</param>
/// <param name="Filtered">Events <see cref="LogbirdOptions.BeforeSend"/> chose to skip.</param>
/// <param name="FailedSends">Batches that failed after all retries and went back to the queue.</param>
/// <param name="QueueLength">Events currently waiting, including a batch being sent.</param>
/// <param name="Warnings">Warnings about events: an identifier a server may index differently from what is sent (surrounding whitespace, longer than the indexed length, a lone surrogate, more than 64 targets; found by the SDK before sending), or a server warning about a stored event such as an adjusted timestamp.</param>
public readonly record struct LogbirdStats(
    long Tracked,
    long Delivered,
    long Rejected,
    long Dropped,
    long Filtered,
    long FailedSends,
    int QueueLength,
    long Warnings = 0);
