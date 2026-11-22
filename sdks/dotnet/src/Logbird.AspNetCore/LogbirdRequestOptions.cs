using System;
using System.Collections.Generic;
using System.Security.Claims;
using Microsoft.AspNetCore.Http;

namespace Logbird.AspNetCore;

/// <summary>
/// How each request fills the audit context. The defaults work with typical JWT and cookie authentication; replace a
/// resolver when your claims differ. Every value an event sets explicitly wins over these.
/// </summary>
public sealed class LogbirdRequestOptions
{
    /// <summary>
    /// The executor id for events recorded during requests and by <see cref="IAuditLogFactory"/>, for example
    /// <c>billing-api</c>. Defaults to the application name.
    /// </summary>
    public string? ServiceName { get; set; }

    /// <summary>Claim types tried, in order, for the actor id. Defaults to <c>sub</c> and <see cref="ClaimTypes.NameIdentifier"/>.</summary>
    public IList<string> ActorIdClaimTypes { get; } = ["sub", ClaimTypes.NameIdentifier];

    /// <summary>Claim types tried, in order, for the actor's display name. Defaults to <c>name</c> and <see cref="ClaimTypes.Name"/>.</summary>
    public IList<string> ActorNameClaimTypes { get; } = ["name", ClaimTypes.Name];

    /// <summary>
    /// Claim types tried, in order, for the actor's email. Empty by default, so no email is recorded unless you opt in
    /// (for example with <c>email</c> and <see cref="ClaimTypes.Email"/>).
    /// </summary>
    public IList<string> ActorEmailClaimTypes { get; } = [];

    /// <summary>Claim types tried, in order, for the tenant id. Defaults to <c>tenant_id</c>.</summary>
    public IList<string> TenantIdClaimTypes { get; } = ["tenant_id"];

    /// <summary>
    /// Resolves the actor for a request. Defaults to a <c>user</c> actor from the claims above when the request is
    /// authenticated, otherwise none. Return <see langword="null"/> for no actor. Runs on the request thread when an
    /// event is recorded; it must be fast. If it throws, the event is recorded without an actor and the error reported.
    /// </summary>
    public Func<HttpContext, AuditActor?>? ResolveActor { get; set; }

    /// <summary>Resolves the tenant for a request. Defaults to the tenant claim above. Same rules as <see cref="ResolveActor"/>.</summary>
    public Func<HttpContext, AuditTenant?>? ResolveTenant { get; set; }

    /// <summary>Resolves the impersonator (for example a support agent acting as the user). None by default.</summary>
    public Func<HttpContext, AuditImpersonator?>? ResolveImpersonator { get; set; }

    /// <summary>
    /// Use an incoming <c>X-Request-Id</c> header as the request id when present (at most 256 characters); otherwise
    /// <see cref="HttpContext.TraceIdentifier"/>. Defaults to <see langword="true"/>.
    /// </summary>
    public bool UseRequestIdHeader { get; set; } = true;

    /// <summary>
    /// Use an incoming <c>X-Logbird-Operation</c> header as the operation id, so one operation can span services.
    /// Defaults to <see langword="true"/>; when absent, each request gets a new operation id.
    /// </summary>
    public bool UseOperationHeader { get; set; } = true;
}
