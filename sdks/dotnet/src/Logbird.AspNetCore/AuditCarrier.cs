using System.Text.Json.Serialization;

namespace Logbird.AspNetCore;

/// <summary>
/// The audit context a background job needs to continue a request's operation: who asked for the work, in which
/// tenant, and which request event caused it. Store it in the job payload (it serializes with System.Text.Json) and
/// pass it to <see cref="IAuditLogFactory.ForJob"/> in the worker.
/// </summary>
public sealed record AuditCarrier
{
    /// <summary>
    /// <c>ToString()</c> lists no values (the carrier holds user and tenant ids). A structured logger that serializes its
    /// properties still sees them, so do not log carriers.
    /// </summary>
#pragma warning disable CA1822 // The compiler-generated record ToString calls this instance member by name.
    private bool PrintMembers(System.Text.StringBuilder builder)
    {
        _ = builder;
        return false;
    }
#pragma warning restore CA1822

    /// <summary>The operation id that groups the request and everything it started.</summary>
    public string? OperationId { get; init; }

    /// <summary>The originating request id.</summary>
    public string? RequestId { get; init; }

    /// <summary>The originating W3C trace id.</summary>
    public string? TraceId { get; init; }

    /// <summary>The event that caused the job, recorded as the jobs' <see cref="AuditContext.ParentEventId"/>.</summary>
    public string? ParentEventId { get; init; }

    /// <summary>Who asked for the work; the worker records it as the actor.</summary>
    public AuditActor? Actor { get; init; }

    /// <summary>The impersonator, if any.</summary>
    public AuditImpersonator? Impersonator { get; init; }

    /// <summary>The tenant the work belongs to.</summary>
    public AuditTenant? Tenant { get; init; }
}

/// <summary>Source-generated serialization for <see cref="AuditCarrier"/>, for trimmed and Native AOT applications.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(AuditCarrier))]
public sealed partial class AuditCarrierJsonContext : JsonSerializerContext
{
}
