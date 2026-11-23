using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Security.Claims;
using System.Text.RegularExpressions;
using Logbird.Internal;
using Microsoft.AspNetCore.Http;

namespace Logbird.AspNetCore;

/// <summary>
/// Records audit events with the current request's context filled in: actor and tenant from the signed-in user, IP,
/// user agent, request, trace and operation ids, and an <c>api</c> executor. Inject it into controllers, minimal API
/// handlers and services. Like the client, it never throws and never waits for the network; it does run your configure
/// callback, the resolvers in <see cref="LogbirdRequestOptions"/> and the event's serialization synchronously, so keep
/// those fast. Events tracked directly through <see cref="ILogbirdClient"/> are not filled in.
/// </summary>
/// <example>
/// <code>
/// app.MapPut("/invoices/{id}", (string id, IAuditLog audit) =>
/// {
///     // ... update the invoice, then:
///     audit.Record("invoice.updated", e => e.Target("invoice", id).Change("status", "draft", "sent"));
/// });
/// </code>
/// </example>
public interface IAuditLog
{
    /// <summary>
    /// Records an event and returns the id it was recorded under (use it as a <see cref="AuditContext.ParentEventId"/>
    /// for follow-up events). If <paramref name="configure"/> throws, the half-built event is not recorded: it is
    /// reported once through <see cref="LogbirdOptions.OnDrop"/> as <see cref="DropReason.Invalid"/>.
    /// </summary>
    /// <param name="action">A stable, dot-separated name, for example <c>invoice.updated</c>.</param>
    /// <param name="configure">
    /// Fills targets, changes and anything else; values set here win over the request context. It must complete
    /// synchronously (an <c>async</c> lambda would let the event be recorded before it finishes).
    /// </param>
    /// <param name="fill">
    /// Which empty fields are filled from the request. When given, it replaces <see cref="LogbirdRequestOptions.Fill"/> for
    /// this call. A field set to <see langword="null"/> counts as empty; to leave it out, remove its flag.
    /// </param>
    string Record(string action, Action<AuditEvent>? configure = null, AuditFill? fill = null);

    /// <summary>Records a copy of a prepared event, filling in what it leaves empty, and returns the id it was recorded under.</summary>
    /// <param name="auditEvent">The event. It is never changed; values it sets win over the request context.</param>
    /// <param name="fill">Which empty fields are filled from the request; when given, it replaces <see cref="LogbirdRequestOptions.Fill"/> for this call.</param>
    string Record(AuditEvent auditEvent, AuditFill? fill = null);

    /// <summary>
    /// Captures the context a background job needs to continue this operation (operation, request and trace ids, actor,
    /// impersonator, tenant), as the request or job sees it, not as one event overrode it. Pass the id of the event that
    /// started the job as <paramref name="parentEventId"/>; to carry an event's own actor or operation instead, adjust
    /// the result with a <c>with</c> expression.
    /// </summary>
    /// <param name="parentEventId">The event that caused the job, usually the id <see cref="Record(string, Action{AuditEvent}, AuditFill?)"/> returned.</param>
    AuditCarrier Carrier(string? parentEventId = null);
}

/// <summary>Creates audit logs for code that runs outside a request, such as background jobs and scheduled work.</summary>
public interface IAuditLogFactory
{
    /// <summary>
    /// An audit log for one job attempt. With a carrier, events keep exactly the carrier's actor, impersonator, tenant,
    /// request and trace ids and parent event (absent values stay absent; only a missing operation id is generated, so the
    /// job's events still share one), and record the worker as executor.
    /// Without a carrier (scheduled work), the actor is <c>AuditActor.System(worker)</c>, the operation is new and the
    /// trace id is the one current when this method is called. <see cref="IAuditLog.Carrier"/> on the result hands the
    /// same context to a follow-up job.
    /// </summary>
    /// <param name="carrier">The context captured with <see cref="IAuditLog.Carrier"/> when the job was enqueued.</param>
    /// <param name="jobId">The job id.</param>
    /// <param name="attempt">The attempt number, starting at 1.</param>
    /// <param name="worker">The worker or queue name; defaults to the service name.</param>
    IAuditLog ForJob(AuditCarrier? carrier, string? jobId = null, int? attempt = null, string? worker = null);
}

/// <summary>Which empty fields <see cref="IAuditLog"/> fills from the request or job context.</summary>
[Flags]
public enum AuditFill
{
    /// <summary>Fill nothing.</summary>
    None = 0,

    /// <summary>The actor (from the signed-in user, or the job's carrier).</summary>
    Actor = 1,

    /// <summary>The tenant.</summary>
    Tenant = 2,

    /// <summary>The impersonator (only when a resolver or carrier provides one).</summary>
    Impersonator = 4,

    /// <summary>The executor (<c>api</c> for requests, <c>worker</c> for jobs).</summary>
    Executor = 8,

    /// <summary>The operation, request and trace ids, and a job's parent event.</summary>
    Correlation = 16,

    /// <summary>The client IP address.</summary>
    Ip = 32,

    /// <summary>The user agent.</summary>
    UserAgent = 64,

    /// <summary>Everything above.</summary>
    All = Actor | Tenant | Impersonator | Executor | Correlation | Ip | UserAgent,
}

/// <summary>The per-request context, captured once per request (the middleware, or the first event or carrier).</summary>
internal sealed class AuditRequestFeature
{
    public string OperationId { get; init; } = string.Empty;

    public string? RequestId { get; init; }

    public string? TraceId { get; init; }

    public string? Ip { get; init; }

    public string? UserAgent { get; init; }
}

/// <summary>
/// Where <see cref="IAuditLog"/> records: the registered <see cref="ILogbirdClient"/> receives the events (a client the
/// host registered itself, such as a fake in tests or a decorator, included). Drops and diagnostics always go through
/// Logbird's own client, so they reach <see cref="LogbirdOptions.OnDrop"/>, <see cref="LogbirdOptions.OnError"/>, the
/// logger and the counters whichever client records.
/// </summary>
internal sealed class AuditSink
{
    private readonly ILogbirdClient _client;
    private readonly LogbirdClient? _core;
    private readonly LogbirdClient _reporter;

    public AuditSink(ILogbirdClient client, LogbirdClient reporter)
    {
        _client = client;
        _reporter = reporter;
        _core = client switch
        {
            HostedLogbirdClient hosted => hosted.Core,
            LogbirdClient core => core,
            _ => null,
        };
    }

    /// <summary>Tracks the event and returns the id it was recorded under. Never throws.</summary>
    public string Track(AuditEvent auditEvent)
    {
        if (_core is not null)
        {
            return _core.TrackCore(auditEvent) ?? auditEvent.Id ?? string.Empty;
        }

        try
        {
            _client.Track(auditEvent);
        }
        catch
        {
            // ILogbirdClient.Track must not throw; a host implementation that does is not allowed into the request.
        }

        return auditEvent.Id ?? string.Empty;
    }

    public void Diagnostic(string message) => (_core ?? _reporter).ReportDiagnostic(message);

    public void Drop(DropReason reason, string? id, string? action, string detail) => (_core ?? _reporter).DropUnrecorded(reason, id, action, detail);
}

/// <summary>The path every <see cref="IAuditLog"/> records through: copy, fill, track, never throw.</summary>
internal static class Recording
{
    public static string RecordNew(AuditSink client, string? action, Action<AuditEvent>? configure, Action<AuditEvent> fill)
    {
        var name = action ?? string.Empty;
        var auditEvent = new AuditEvent(name);
        try
        {
            configure?.Invoke(auditEvent);
        }
        catch (Exception e)
        {
            // A half-built event would record wrong data, so it is not recorded; the drop is reported once, under the id the
            // callback set or a new one.
            var id = SafeId(auditEvent) ?? LogbirdClient.NewEventId();
            client.Drop(DropReason.Invalid, id, name, "the configure callback threw " + e.GetType().Name + ".");
            return id;
        }

        return Finish(client, auditEvent, fill);
    }

    public static string RecordPrepared(AuditSink client, AuditEvent? prepared, Action<AuditEvent> fill)
    {
        if (prepared is null)
        {
            client.Drop(DropReason.Invalid, null, null, "Record was called without an event.");
            return string.Empty;
        }

        AuditEvent copy;
        try
        {
            // The client's own pre-copy checks (depth, and the 1 MiB memory guard before redaction) apply before anything is
            // copied: an event they refuse is dropped and reported here, under its id or a new one, without copying it or
            // handing the caller's instance to any client. The 256 KB limit is decided later by the client, on what it sends
            // (after BeforeSend and redaction).
            if (LogbirdClient.RefuseBeforeCopy(prepared) is { } refusal)
            {
                var dropped = SafeId(prepared) ?? LogbirdClient.NewEventId();
                client.Drop(refusal.Reason, dropped, SafeAction(prepared), refusal.Detail);
                return dropped;
            }

            copy = prepared.Clone();
        }
        catch (Exception e)
        {
            var id = SafeId(prepared) ?? LogbirdClient.NewEventId();
            client.Drop(DropReason.Invalid, id, SafeAction(prepared), "the event could not be copied (" + e.GetType().Name + ").");
            return id;
        }

        return Finish(client, copy, fill);
    }

    private static string Finish(AuditSink client, AuditEvent auditEvent, Action<AuditEvent> fill)
    {
        try
        {
            // The context may be a template the caller shares between events; fill a private copy.
            var context = auditEvent.Context;
            auditEvent.Context = new AuditContext
            {
                OperationId = context.OperationId,
                ParentEventId = context.ParentEventId,
                RequestId = context.RequestId,
                TraceId = context.TraceId,
                Ip = context.Ip,
                UserAgent = context.UserAgent,
            };
            // The id is decided here (on the private event), so a disabled or host-provided client returns it too.
            auditEvent.Id ??= LogbirdClient.NewEventId();
            fill(auditEvent);
        }
        catch (Exception e)
        {
            // Each fill step is guarded on its own; this only catches the unexpected, and the event is still recorded.
            client.Diagnostic("Logbird could not fill an audit event's context (" + e.GetType().Name + "); it was recorded with what was available.");
        }

        return client.Track(auditEvent);
    }

    private static string? SafeId(AuditEvent auditEvent)
    {
        try
        {
            return auditEvent.Id;
        }
        catch
        {
            return null;
        }
    }

    private static string? SafeAction(AuditEvent auditEvent)
    {
        try
        {
            return auditEvent.Action;
        }
        catch
        {
            return null;
        }
    }
}

/// <summary>The request-scoped <see cref="IAuditLog"/>.</summary>
internal sealed class RequestAuditLog(AuditSink sink, IHttpContextAccessor accessor, LogbirdRequestOptions options) : IAuditLog
{
    // Resolvers are synchronous, so a thread-static flag sees a Record made from inside one.
    [ThreadStatic]
    private static bool t_resolving;

    private AuditSink Client => sink;

    public string Record(string action, Action<AuditEvent>? configure = null, AuditFill? fill = null)
        => Recording.RecordNew(Client, action, configure, e => Fill(e, fill ?? options.Fill));

    public string Record(AuditEvent auditEvent, AuditFill? fill = null)
        => Recording.RecordPrepared(Client, auditEvent, e => Fill(e, fill ?? options.Fill));

    public AuditCarrier Carrier(string? parentEventId = null)
    {
        try
        {
            var http = accessor.HttpContext;
            var feature = http is null ? null : RequestContext.GetOrCapture(http, options, Client);

            // A request's carrier can always be written and read back unchanged (AuditCarrier.ToJson): a resolved party
            // or an id that could not (a party without its id, a lone surrogate) is left out and reported, never changed.
            var operationId = Kept(feature?.OperationId, "operation id");
            var actor = http is null ? null : Resolve(options.ResolveActor ?? DefaultActor, http, "actor");
            var impersonator = http is null || options.ResolveImpersonator is null ? null : Resolve(options.ResolveImpersonator, http, "impersonator");
            var tenant = http is null ? null : Resolve(options.ResolveTenant ?? DefaultTenant, http, "tenant");
            return new AuditCarrier
            {
                OperationId = operationId ?? LogbirdClient.NewEventId(),
                RequestId = Kept(feature?.RequestId, "request id"),
                TraceId = Kept(feature is null ? RequestContext.CurrentTraceId() : feature.TraceId, "trace id"),
                ParentEventId = Kept(parentEventId, "parent event id"),
                Actor = actor is null || AuditCarrier.Writable(actor) ? actor : Left<AuditActor>("actor"),
                Impersonator = impersonator is null || AuditCarrier.Writable(impersonator) ? impersonator : Left<AuditImpersonator>("impersonator"),
                Tenant = tenant is null || AuditCarrier.Writable(tenant) ? tenant : Left<AuditTenant>("tenant"),
            };
        }
        catch (Exception e)
        {
            Client.Diagnostic("Logbird could not capture an audit carrier (" + e.GetType().Name + "); a new operation was started.");
            return new AuditCarrier { OperationId = LogbirdClient.NewEventId(), ParentEventId = Kept(parentEventId, "parent event id") };
        }
    }

    /// <summary>A carrier id, or null (reported) when it holds a lone surrogate and could not be read back unchanged.</summary>
    private string? Kept(string? id, string what)
    {
        if (AuditCarrier.Writable(id))
        {
            return id;
        }

        Client.Diagnostic("Logbird left the " + what + " out of an audit carrier: it holds a lone surrogate, which a carrier cannot carry unchanged.");
        return null;
    }

    /// <summary>A resolved party the carrier leaves out (reported): without its id, or holding a lone surrogate.</summary>
    private T? Left<T>(string what)
        where T : class
    {
        Client.Diagnostic("Logbird left the " + what + " out of an audit carrier: it has no id (or an actor no type) or holds a lone surrogate, so a carrier could not carry it unchanged.");
        return null;
    }

    private void Fill(AuditEvent e, AuditFill fill)
    {
        var http = accessor.HttpContext;
        if (http is not null)
        {
            var feature = RequestContext.GetOrCapture(http, options, Client);
            var context = e.Context;
            if ((fill & AuditFill.Correlation) != 0)
            {
                context.OperationId ??= feature.OperationId;
                context.RequestId ??= feature.RequestId;
                context.TraceId ??= feature.TraceId;
            }

            if ((fill & AuditFill.Ip) != 0)
            {
                context.Ip ??= feature.Ip;
            }

            if ((fill & AuditFill.UserAgent) != 0)
            {
                context.UserAgent ??= feature.UserAgent;
            }

            if ((fill & AuditFill.Actor) != 0 && e.Actor is null)
            {
                e.Actor = Resolve(options.ResolveActor ?? DefaultActor, http, "actor");
            }

            if ((fill & AuditFill.Tenant) != 0 && e.Tenant is null)
            {
                e.Tenant = Resolve(options.ResolveTenant ?? DefaultTenant, http, "tenant");
            }

            if ((fill & AuditFill.Impersonator) != 0 && e.Impersonator is null && options.ResolveImpersonator is not null)
            {
                e.Impersonator = Resolve(options.ResolveImpersonator, http, "impersonator");
            }
        }

        if ((fill & AuditFill.Executor) != 0)
        {
            e.Executor ??= AuditExecutor.Api(options.ServiceName);
        }
    }

    private T? Resolve<T>(Func<HttpContext, T?> resolver, HttpContext http, string kind)
        where T : class
    {
        // A resolver that records an audit event itself would otherwise resolve again for that event, without end.
        if (t_resolving)
        {
            return null;
        }

        t_resolving = true;
        try
        {
            return resolver(http);
        }
        catch (Exception e)
        {
            Client.Diagnostic("Logbird: the " + kind + " resolver threw " + e.GetType().Name + "; the event was recorded without it.");
            return null;
        }
        finally
        {
            t_resolving = false;
        }
    }

    // Defaults read only the authenticated primary identity, so claims from another identity on the principal never mix in.
    private AuditActor? DefaultActor(HttpContext http)
    {
        var identity = RequestContext.AuthenticatedIdentity(http);
        var id = identity is null ? null : RequestContext.FirstClaim(identity, options.ActorIdClaimTypes);
        if (identity is null || string.IsNullOrEmpty(id))
        {
            return null;
        }

        return AuditActor.User(id!, RequestContext.FirstClaim(identity, options.ActorNameClaimTypes), RequestContext.FirstClaim(identity, options.ActorEmailClaimTypes));
    }

    private AuditTenant? DefaultTenant(HttpContext http)
    {
        var identity = RequestContext.AuthenticatedIdentity(http);
        var id = identity is null ? null : RequestContext.FirstClaim(identity, options.TenantIdClaimTypes);
        return string.IsNullOrEmpty(id) ? null : new AuditTenant(id!);
    }
}

/// <summary>An <see cref="IAuditLog"/> for one background job attempt.</summary>
internal sealed class JobAuditLog : IAuditLog
{
    private readonly AuditSink _client;
    private readonly AuditCarrier _context;
    private readonly AuditExecutor _executor;
    private readonly AuditFill _defaultFill;

    public JobAuditLog(AuditSink client, AuditCarrier? carrier, AuditExecutor executor, AuditFill defaultFill)
    {
        _client = client;
        _executor = executor;
        _defaultFill = defaultFill;

        // Decided once, so Record and Carrier agree: a carrier is kept as it is (absent values stay absent); scheduled
        // work gets a system actor, a new operation and the trace current now.
        _context = carrier is not null
            ? carrier with { OperationId = carrier.OperationId ?? LogbirdClient.NewEventId() }
            : new AuditCarrier
            {
                OperationId = LogbirdClient.NewEventId(),
                TraceId = RequestContext.CurrentTraceId(),
                Actor = AuditActor.System(executor.Id ?? "worker"),
            };
    }

    public string Record(string action, Action<AuditEvent>? configure = null, AuditFill? fill = null)
        => Recording.RecordNew(_client, action, configure, e => Fill(e, fill ?? _defaultFill));

    public string Record(AuditEvent auditEvent, AuditFill? fill = null)
        => Recording.RecordPrepared(_client, auditEvent, e => Fill(e, fill ?? _defaultFill));

    public AuditCarrier Carrier(string? parentEventId = null) => _context with { ParentEventId = parentEventId };

    private void Fill(AuditEvent e, AuditFill fill)
    {
        if ((fill & AuditFill.Actor) != 0)
        {
            e.Actor ??= _context.Actor;
        }

        if ((fill & AuditFill.Impersonator) != 0)
        {
            e.Impersonator ??= _context.Impersonator;
        }

        if ((fill & AuditFill.Tenant) != 0)
        {
            e.Tenant ??= _context.Tenant;
        }

        if ((fill & AuditFill.Executor) != 0)
        {
            e.Executor ??= _executor;
        }

        if ((fill & AuditFill.Correlation) != 0)
        {
            var context = e.Context;
            context.OperationId ??= _context.OperationId;
            context.RequestId ??= _context.RequestId;
            context.TraceId ??= _context.TraceId;
            context.ParentEventId ??= _context.ParentEventId;
        }
    }
}

internal sealed class AuditLogFactory(AuditSink sink, LogbirdRequestOptions options) : IAuditLogFactory
{
    public IAuditLog ForJob(AuditCarrier? carrier, string? jobId = null, int? attempt = null, string? worker = null)
        => new JobAuditLog(sink, carrier, AuditExecutor.Worker(worker ?? options.ServiceName ?? "worker", jobId, attempt), options.Fill);
}

/// <summary>Captures request details once per request.</summary>
internal static partial class RequestContext
{
    private const int MaxIdLength = 256;
    private const int MaxUserAgentLength = 1024;

    /// <summary>
    /// The request's context: captured once and stored on the request, so the middleware, events recorded before it,
    /// and a re-executed pipeline (an exception handler) all share one operation id.
    /// </summary>
    public static AuditRequestFeature GetOrCapture(HttpContext http, LogbirdRequestOptions options, AuditSink client)
    {
        AuditRequestFeature? existing = null;
        try
        {
            existing = http.Features.Get<AuditRequestFeature>();
        }
        catch (Exception e)
        {
            Report(client, "stored context", e);
        }

        if (existing is not null)
        {
            return existing;
        }

        var captured = Capture(http, options, client);
        try
        {
            http.Features.Set(captured);
        }
        catch (Exception e)
        {
            Report(client, "stored context", e);
        }

        return captured;
    }

    private static AuditRequestFeature Capture(HttpContext http, LogbirdRequestOptions options, AuditSink client)
    {
        // Each detail is optional: one that cannot be read is left out and reported; the rest are still captured.
        var operation = options.UseOperationHeader ? Read(client, "operation header", () => Id(http.Request.Headers, "X-Logbird-Operation")) : null;
        var requestId = options.UseRequestIdHeader ? Read(client, "request id header", () => Id(http.Request.Headers, "X-Request-Id")) : null;
        return new AuditRequestFeature
        {
            OperationId = operation ?? LogbirdClient.NewEventId(),
            RequestId = requestId ?? Read(client, "trace identifier", () => http.TraceIdentifier),
            TraceId = Read(client, "trace id", () => CurrentTraceId() ?? TraceParent(Header(http.Request.Headers, "traceparent"))),
            Ip = Read(client, "client IP", () => http.Connection.RemoteIpAddress?.ToString()),
            UserAgent = Read(client, "user agent", () => Truncate(Header(http.Request.Headers, "User-Agent"), MaxUserAgentLength)),
        };
    }

    /// <summary>The current W3C trace id, if a non-zero one is active.</summary>
    public static string? CurrentTraceId()
    {
        var activity = Activity.Current;
        if (activity is null || activity.IdFormat != ActivityIdFormat.W3C)
        {
            return null;
        }

        var id = activity.TraceId.ToHexString();
        return id == "00000000000000000000000000000000" ? null : id;
    }

    /// <summary>The request's primary identity, when it is authenticated.</summary>
    public static ClaimsIdentity? AuthenticatedIdentity(HttpContext http)
        => http.User?.Identity is ClaimsIdentity { IsAuthenticated: true } identity ? identity : null;

    public static string? FirstClaim(ClaimsIdentity identity, IEnumerable<string> types)
    {
        foreach (var type in types)
        {
            var value = identity.FindFirst(type)?.Value;
            if (!string.IsNullOrEmpty(value))
            {
                return value;
            }
        }

        return null;
    }

    private static string? Read(AuditSink client, string what, Func<string?> read)
    {
        try
        {
            return read();
        }
        catch (Exception e)
        {
            Report(client, what, e);
            return null;
        }
    }

    private static void Report(AuditSink client, string what, Exception e)
        => client.Diagnostic("Logbird could not read the request's " + what + " (" + e.GetType().Name + "); events are recorded without it.");

    private static string? TraceParent(string? header)
    {
        if (header is null)
        {
            return null;
        }

        var match = TraceParentPattern().Match(header);

        // Version ff is forbidden; an all-zero trace or parent id is invalid.
        if (!match.Success || match.Groups[1].Value == "ff" || match.Groups[2].Value == "00000000000000000000000000000000" || match.Groups[3].Value == "0000000000000000")
        {
            return null;
        }

        return match.Groups[2].Value;
    }

    // A correlation id is used whole or not at all: cutting it could make two different ids equal.
    private static string? Id(IHeaderDictionary headers, string name)
        => Header(headers, name) is { Length: <= MaxIdLength } value ? value : null;

    private static string? Header(IHeaderDictionary headers, string name)
    {
        if (!headers.TryGetValue(name, out var values) || values.Count != 1)
        {
            return null;
        }

        var value = values[0];
        return string.IsNullOrEmpty(value) ? null : value;
    }

    // Descriptive text only; never splits a surrogate pair.
    private static string? Truncate(string? value, int maxLength)
    {
        if (value is null || value.Length <= maxLength)
        {
            return value;
        }

        var length = char.IsHighSurrogate(value[maxLength - 1]) ? maxLength - 1 : maxLength;
        return value.Substring(0, length);
    }

    [GeneratedRegex("^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 100)]
    private static partial Regex TraceParentPattern();
}
