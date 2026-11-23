using System;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Logbird.AspNetCore;

/// <summary>
/// The audit context a background job needs to continue a request's operation: who asked for the work, in which
/// tenant, and which request event caused it. Store it in the job payload and pass it to
/// <see cref="IAuditLogFactory.ForJob"/> in the worker. It serializes with System.Text.Json; in a trimmed or Native AOT
/// application, use <see cref="ToJson"/> and <see cref="FromJson(string)"/>, or include it in your own
/// source-generated context.
/// </summary>
public sealed record AuditCarrier
{
    /// <summary>The carrier as JSON (camelCase, absent values left out), safe under trimming and Native AOT.</summary>
    public string ToJson() => JsonSerializer.Serialize(this, AuditCarrierJsonContext.Default.AuditCarrier);

    /// <summary>The carrier as UTF-8 JSON bytes, the same JSON as <see cref="ToJson"/>.</summary>
    public byte[] ToJsonUtf8Bytes() => JsonSerializer.SerializeToUtf8Bytes(this, AuditCarrierJsonContext.Default.AuditCarrier);

    /// <summary>Reads a carrier written by <see cref="ToJson"/> (or any System.Text.Json serialization of it).</summary>
    /// <param name="json">The JSON text.</param>
    /// <exception cref="ArgumentNullException"><paramref name="json"/> is null.</exception>
    /// <exception cref="JsonException">The text is not a JSON object of a carrier.</exception>
    public static AuditCarrier FromJson(string json)
    {
        Logbird.Internal.Guard.NotNull(json, nameof(json));
        return JsonSerializer.Deserialize(json, AuditCarrierJsonContext.Default.AuditCarrier)
            ?? throw new JsonException("The JSON is null, not a carrier.");
    }

    /// <summary>Reads a carrier from UTF-8 JSON bytes written by <see cref="ToJsonUtf8Bytes"/>.</summary>
    /// <param name="utf8Json">The UTF-8 JSON bytes.</param>
    /// <exception cref="JsonException">The bytes are not a JSON object of a carrier.</exception>
    public static AuditCarrier FromJson(ReadOnlySpan<byte> utf8Json)
        => JsonSerializer.Deserialize(utf8Json, AuditCarrierJsonContext.Default.AuditCarrier)
            ?? throw new JsonException("The JSON is null, not a carrier.");

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

/// <summary>Source-generated serialization behind <see cref="AuditCarrier.ToJson"/> and <see cref="AuditCarrier.FromJson(string)"/>.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(AuditCarrier))]
internal sealed partial class AuditCarrierJsonContext : JsonSerializerContext
{
}
