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

    /// <summary>
    /// The event as sent (after <see cref="LogbirdOptions.BeforeSend"/> and redaction) is larger than 256 KB of UTF-8 JSON.
    /// Separately, an event whose data measures more than 1 MiB before redaction is refused without being copied, whatever
    /// redaction would have removed: copying an unbounded tree to redact it could exhaust the host's memory. That guard
    /// counts one byte per UTF-16 code unit of every text the event carries (fields, context, targets, change fields,
    /// metadata keys and values), plus JSON punctuation and the digits of parsed numbers: a lower bound of the JSON's size,
    /// so it never refuses an event whose JSON would be under 1 MiB. <see cref="DroppedEvent.MayBeStored"/> is false: the
    /// event was never sent.
    /// </summary>
    TooLarge = 3,

    /// <summary>
    /// The client shut down before delivery was confirmed: its shutdown timeout (or the host's budget) ran out with the
    /// event queued or in flight, or the event was tracked after shutdown began. An event in flight may have been stored;
    /// see <see cref="DroppedEvent.MayBeStored"/>.
    /// </summary>
    Shutdown = 4,

    /// <summary>
    /// The event could not be prepared, for example because <see cref="LogbirdOptions.BeforeSend"/> threw, or its metadata
    /// or a change value nests JSON deeper than 1,000 levels (a value that is part of a larger tree of yours also counts
    /// the parents it has there), checked on the event as given (before
    /// <see cref="LogbirdOptions.BeforeSend"/> and redaction: a deep part they would remove still counts, because walking it
    /// is the risk). The limit keeps System.Text.Json's internal recursion (a node looks its options up through its parents)
    /// within the stack, where an overflow would end the host process; it is tested on a 256 KB thread stack. It is the
    /// number the server uses for exact numbers, but the server applies it differently: to the objects and arrays of the
    /// whole event, and only when the event holds, anywhere, a number a double cannot keep exactly. So a deeper tree in an
    /// event without such a number, which the server would store, is refused here; and because a change value sits three
    /// levels into the event, a change value whose objects or arrays nest more than 997 levels (a leaf at level 999 or
    /// deeper), in an event holding such a number, is rejected by the server (<see cref="Rejected"/>).
    /// </summary>
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

    /// <summary>
    /// The longest <see cref="Id"/> and <see cref="Action"/> reported whole, in UTF-16 code units: far more than any
    /// event Logbird stores can have (the server takes ids of at most 256 code units, trimmed, and actions of at most 200).
    /// </summary>
    public const int MaxIdLength = 65_536;

    /// <summary>The longest <see cref="Detail"/> reported whole, in UTF-16 code units.</summary>
    public const int MaxDetailLength = 1_024;

    internal DroppedEvent(DropReason reason, string? id, string action, byte[]? json, string? detail, string? code = null, bool mayBeStored = false)
    {
        Reason = reason;
        var truncated = false;
        Id = Bounded(id, MaxIdLength, ref truncated);
        Action = Bounded(action, MaxIdLength, ref truncated)!;
        _json = json;
        Detail = Bounded(detail, MaxDetailLength, ref truncated);
        Code = code;
        MayBeStored = mayBeStored;
        Truncated = truncated;
    }

    /// <summary>Why the event was dropped.</summary>
    public DropReason Reason { get; }

    /// <summary>
    /// The event id exactly as the event carried it, the one to correlate the drop with your own records (an outbox row,
    /// for one), or <see langword="null"/> when it had none yet. It is never cut unless it is longer than
    /// <see cref="MaxIdLength"/>, which no storable event's id is; <see cref="Truncated"/> then says so.
    /// </summary>
    public string? Id { get; }

    /// <summary>The event action, never cut unless it is longer than <see cref="MaxIdLength"/> (see <see cref="Truncated"/>).</summary>
    public string Action { get; }

    /// <summary>
    /// The server's reason for a <see cref="DropReason.Rejected"/> event, or another short explanation. At most
    /// <see cref="MaxDetailLength"/> code units: a longer one is cut there, and <see cref="Truncated"/> says so.
    /// </summary>
    public string? Detail { get; }

    /// <summary>
    /// Whether <see cref="Id"/>, <see cref="Action"/> or <see cref="Detail"/> was cut to its limit (never inside a surrogate
    /// pair). An id is cut only past <see cref="MaxIdLength"/>, so a <see langword="false"/> here means every field is
    /// exactly as given, and a cut <see cref="Id"/> is never mistaken for another event's.
    /// </summary>
    public bool Truncated { get; }

    private static string? Bounded(string? value, int max, ref bool truncated)
    {
        if (value is null || value.Length <= max)
        {
            return value;
        }

        truncated = true;
        var length = char.IsHighSurrogate(value[max - 1]) ? max - 1 : max;
        return value.Substring(0, length);
    }

    /// <summary>
    /// The server's code for a <see cref="DropReason.Rejected"/> event, for example <c>invalid_event</c> or
    /// <c>invalid_entity_id</c>; <c>other</c> for a code this SDK does not know. Null for every other reason.
    /// </summary>
    public string? Code { get; }

    /// <summary>
    /// Whether the server may have stored this event even though the SDK dropped it. True when the event was put on the
    /// wire at least once and no answer settled it: a request ended without an answer, or with a 5xx, or with a success
    /// that did not acknowledge it, or it was still in flight at shutdown. False when the event was never sent, or every
    /// answer for it said it was not stored. <see cref="DropReason.TooLarge"/> and <see cref="DropReason.Invalid"/> are
    /// always false; <see cref="DropReason.Rejected"/> is false too, except for the codes <c>stored_event_unreadable</c>
    /// and <c>unverified_after_parse_failure</c>, which keep an earlier unresolved outcome. A "dropped" event is not necessarily absent: when this is true,
    /// resend <see cref="Json"/> (the server deduplicates by id) or look the id up before treating the event as lost.
    /// </summary>
    public bool MayBeStored { get; }

    /// <summary>
    /// The exact JSON that was (or would have been) sent, as UTF-8, after redaction. Persist it to replay the event later
    /// with the same id. Empty when the event was dropped before it was serialized: <see cref="DropReason.TooLarge"/> and
    /// <see cref="DropReason.Invalid"/> (and <see cref="DropReason.Shutdown"/> for an event tracked after shutdown) can be;
    /// <see cref="Id"/> then still identifies it.
    /// </summary>
    public ReadOnlyMemory<byte> Json => _json ?? ReadOnlyMemory<byte>.Empty;

    /// <summary>The JSON as a string.</summary>
    public string JsonText => _json is null ? string.Empty : Encoding.UTF8.GetString(_json);
}

/// <summary>
/// A snapshot of a client's counters since it was created, read from <see cref="ILogbirdClient.Stats"/>. Only the SDK
/// fills one; <c>default(LogbirdStats)</c> is a snapshot with every count zero, for a test double that implements
/// <see cref="ILogbirdClient"/>. Later versions may add counters. Unlike the event records, its <c>ToString()</c> prints
/// its values on purpose: they are counts only and carry no event, identity or query data.
/// </summary>
public readonly struct LogbirdStats
{
    internal LogbirdStats(long tracked, long delivered, long rejected, long dropped, long filtered, long failedSends, int queueLength, long warnings = 0)
    {
        Tracked = tracked;
        Delivered = delivered;
        Rejected = rejected;
        Dropped = dropped;
        Filtered = filtered;
        FailedSends = failedSends;
        QueueLength = queueLength;
        Warnings = warnings;
    }

    /// <summary>Events accepted into the queue.</summary>
    public long Tracked { get; }

    /// <summary>Events the server stored (or already had, for a retry).</summary>
    public long Delivered { get; }

    /// <summary>Events the server rejected individually.</summary>
    public long Rejected { get; }

    /// <summary>Events dropped for any other reason (queue full, permanent HTTP error, too large, invalid, shutdown).</summary>
    public long Dropped { get; }

    /// <summary>Events <see cref="LogbirdOptions.BeforeSend"/> chose to skip.</summary>
    public long Filtered { get; }

    /// <summary>Batches that failed after all retries and went back to the queue.</summary>
    public long FailedSends { get; }

    /// <summary>Events currently waiting, including a batch being sent.</summary>
    public int QueueLength { get; }

    /// <summary>
    /// Warnings about events: an identifier a server may index differently from what is sent (surrounding whitespace,
    /// longer than the indexed length, a lone surrogate, more than 64 targets; found by the SDK before sending), or a
    /// server warning about a stored event such as an adjusted timestamp.
    /// </summary>
    public long Warnings { get; }

    /// <summary>The counts, for example <c>LogbirdStats { Tracked = 5, Delivered = 3, ... }</c>.</summary>
    public override string ToString()
        => FormattableString.Invariant(
            $"LogbirdStats {{ Tracked = {Tracked}, Delivered = {Delivered}, Rejected = {Rejected}, Dropped = {Dropped}, Filtered = {Filtered}, FailedSends = {FailedSends}, QueueLength = {QueueLength}, Warnings = {Warnings} }}");
}
