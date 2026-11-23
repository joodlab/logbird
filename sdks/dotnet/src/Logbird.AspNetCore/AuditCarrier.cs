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
    /// <summary>
    /// The carrier as JSON (camelCase, absent values left out), safe under trimming and Native AOT. Whatever it writes,
    /// <see cref="FromJson(string)"/> reads back.
    /// </summary>
    /// <exception cref="InvalidOperationException">
    /// The carrier names an actor, impersonator or tenant without its id (or an actor without its type), which
    /// <see cref="FromJson(string)"/> would refuse. A request's <see cref="IAuditLog.Carrier"/> never does; a job's keeps the
    /// parties of the carrier it was started with, so a carrier built or read outside these methods can still fail here.
    /// </exception>
    public string ToJson() => JsonSerializer.Serialize(Writable(), AuditCarrierJsonContext.Default.AuditCarrier);

    /// <summary>The carrier as UTF-8 JSON bytes, the same JSON as <see cref="ToJson"/>.</summary>
    /// <exception cref="InvalidOperationException">As for <see cref="ToJson"/>.</exception>
    public byte[] ToJsonUtf8Bytes() => JsonSerializer.SerializeToUtf8Bytes(Writable(), AuditCarrierJsonContext.Default.AuditCarrier);

    /// <summary>This carrier, refused when the JSON it would write could not be read back.</summary>
    private AuditCarrier Writable()
        => HasPartyWithoutIdentity(this)
            ? throw new InvalidOperationException("The carrier names an actor, impersonator or tenant without its id (or an actor without its type); it cannot be read back.")
            : this;

    private static bool HasPartyWithoutIdentity(AuditCarrier carrier)
        => (carrier.Actor is { } actor && (actor.Type is null || actor.Id is null))
            || (carrier.Impersonator is { } impersonator && impersonator.Id is null)
            || (carrier.Tenant is { } tenant && tenant.Id is null);

    /// <summary>
    /// Reads a carrier from the JSON <see cref="ToJson"/> writes. Member names are matched without regard to case, so the
    /// PascalCase a default <c>JsonSerializer.Serialize</c> writes is read too. An empty object is a carrier with
    /// nothing in it.
    /// </summary>
    /// <param name="json">The JSON text.</param>
    /// <exception cref="ArgumentNullException"><paramref name="json"/> is null.</exception>
    /// <exception cref="JsonException">
    /// The text is not valid JSON or not a carrier: <c>null</c>, not an object, a member a carrier does not have, or an
    /// actor, impersonator or tenant without its id (or an actor without its type).
    /// </exception>
    public static AuditCarrier FromJson(string json)
    {
        Logbird.Internal.Guard.NotNull(json, nameof(json));
        AuditCarrier? carrier;
        try
        {
            carrier = JsonSerializer.Deserialize(json, AuditCarrierJsonContext.Default.AuditCarrier);
        }
        catch (ArgumentException e)
        {
            // The text cannot be transcoded to UTF-8 (a lone surrogate): it is not JSON.
            throw new JsonException("The text is not valid JSON.", e);
        }

        return Checked(carrier);
    }

    /// <summary>Reads a carrier from UTF-8 JSON bytes, such as those <see cref="ToJsonUtf8Bytes"/> writes.</summary>
    /// <param name="utf8Json">The UTF-8 JSON bytes.</param>
    /// <exception cref="JsonException">The bytes are not valid JSON or not a carrier, as for <see cref="FromJson(string)"/>.</exception>
    public static AuditCarrier FromJson(ReadOnlySpan<byte> utf8Json)
        => Checked(JsonSerializer.Deserialize(utf8Json, AuditCarrierJsonContext.Default.AuditCarrier));

    /// <summary>A carrier read from JSON, refused when it is null or names a party without its identity.</summary>
    private static AuditCarrier Checked(AuditCarrier? carrier)
    {
        if (carrier is null)
        {
            throw new JsonException("The JSON is null, not a carrier.");
        }

        if (HasPartyWithoutIdentity(carrier))
        {
            throw new JsonException("The carrier names an actor, impersonator or tenant without its id (or an actor without its type).");
        }

        return carrier;
    }

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
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    PropertyNameCaseInsensitive = true,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow)]
[JsonSerializable(typeof(AuditCarrier))]
internal sealed partial class AuditCarrierJsonContext : JsonSerializerContext
{
}
