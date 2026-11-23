using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;

namespace Logbird;

/// <summary>
/// A delivery problem reported through <see cref="LogbirdOptions.OnError"/> and the logger. It is never thrown into
/// your code by <c>Track</c>, <c>FlushAsync</c> or disposal. Messages never contain event data or keys.
/// </summary>
public class LogbirdDeliveryException : Exception
{
    /// <summary>Creates the exception.</summary>
    /// <param name="message">A safe description.</param>
    public LogbirdDeliveryException(string message)
        : base(message)
    {
    }

    /// <summary>Creates the exception with the HTTP status the server answered.</summary>
    /// <param name="message">A safe description.</param>
    /// <param name="statusCode">The HTTP status.</param>
    public LogbirdDeliveryException(string message, HttpStatusCode statusCode)
        : base(message)
    {
        StatusCode = statusCode;
    }

    /// <summary>Creates the exception with the underlying network error.</summary>
    /// <param name="message">A safe description.</param>
    /// <param name="innerException">The underlying error.</param>
    public LogbirdDeliveryException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    /// <summary>The HTTP status, when the server answered.</summary>
    public HttpStatusCode? StatusCode { get; }
}

/// <summary>
/// An event needs attention, reported through <see cref="LogbirdOptions.OnError"/> and the logger; nothing was dropped.
/// The SDK's own warning (an identifier a server may index differently from what is sent: surrounding whitespace, longer
/// than the indexed length, a lone surrogate, more than 64 targets) is raised by <c>Track</c> just after it queues the
/// event, so a flush may already be sending it; a server warning (such as an adjusted <c>occurredAt</c>) is raised after
/// the server stored the event.
/// </summary>
public sealed class LogbirdEventWarning : LogbirdDeliveryException
{
    internal LogbirdEventWarning(string eventId, string action, string reason, string message)
        : base(message)
    {
        EventId = eventId;
        Action = action;
        Reason = reason;
    }

    /// <summary>The event id. Not part of <see cref="Exception.Message"/>, which never contains event data.</summary>
    public string EventId { get; }

    /// <summary>The event action.</summary>
    public string Action { get; }

    /// <summary>
    /// What to look at: for example the SDK's <c>surrounding whitespace in actor.id: sent exactly as given; …</c>, or the
    /// server's reason for an adjusted <c>occurredAt</c>.
    /// </summary>
    public string Reason { get; }
}

/// <summary>The server stored a batch but rejected some of its events. Each rejected event is also passed to <see cref="LogbirdOptions.OnDrop"/>.</summary>
public sealed class LogbirdRejectedException : LogbirdDeliveryException
{
    internal LogbirdRejectedException(int count, IReadOnlyList<string> codes)
        : base($"{count} event(s) rejected by Logbird: {string.Join(", ", codes.Distinct())}.")
    {
        Count = count;
        Codes = codes;
    }

    /// <summary>How many events were rejected.</summary>
    public int Count { get; }

    /// <summary>The rejection code of each event, for example <c>invalid_event</c> or <c>duplicate_id_conflict</c>.</summary>
    public IReadOnlyList<string> Codes { get; }
}
