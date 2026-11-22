namespace Logbird;

/// <summary>Correlation and request details for an event.</summary>
public sealed class AuditContext
{
    /// <summary>Groups a request, the jobs it started and every record they changed. Carry it into background jobs.</summary>
    public string? OperationId { get; set; }

    /// <summary>The id of the event that caused this one, forming a causation tree.</summary>
    public string? ParentEventId { get; set; }

    /// <summary>The request id, for example <c>HttpContext.TraceIdentifier</c> or an <c>X-Request-Id</c> header.</summary>
    public string? RequestId { get; set; }

    /// <summary>The W3C trace id (32 hex characters), linking the event to your distributed traces.</summary>
    public string? TraceId { get; set; }

    /// <summary>The client IP address.</summary>
    public string? Ip { get; set; }

    /// <summary>The client user agent.</summary>
    public string? UserAgent { get; set; }

    internal AuditContext Clone() => (AuditContext)MemberwiseClone();
}
