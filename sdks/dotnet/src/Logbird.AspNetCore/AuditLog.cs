using System;
using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Logbird.AspNetCore;

/// <summary>
/// Records audit events with the current request's context filled in: actor and tenant from the signed-in user, IP,
/// user agent, request, trace and operation ids, and an <c>api</c> executor. Inject it into controllers, minimal API
/// handlers and services. Like the client, it never throws and never waits for the network.
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
    /// <summary>Records an event and returns its id (use it as a <see cref="AuditContext.ParentEventId"/> for follow-up events).</summary>
    /// <param name="action">A stable, dot-separated name, for example <c>invoice.updated</c>.</param>
    /// <param name="configure">Fills targets, changes and anything else; values set here win over the request context.</param>
    string Record(string action, Action<AuditEvent>? configure = null);

    /// <summary>Records a prepared event, filling in what it leaves empty, and returns its id.</summary>
    /// <param name="auditEvent">The event. Values it sets win over the request context.</param>
    string Record(AuditEvent auditEvent);

    /// <summary>
    /// Captures the context a background job needs to continue this operation (operation, request and trace ids, actor,
    /// impersonator, tenant). Pass the id of the event that started the job as <paramref name="parentEventId"/>.
    /// </summary>
    /// <param name="parentEventId">The event that caused the job, usually the id <see cref="Record(string, Action{AuditEvent})"/> returned.</param>
    AuditCarrier Carrier(string? parentEventId = null);
}

/// <summary>Creates audit logs for code that runs outside a request, such as background jobs and scheduled work.</summary>
public interface IAuditLogFactory
{
    /// <summary>
    /// An audit log for one job attempt. Events keep the carrier's actor, tenant, operation and parent event, and record
    /// the worker as executor. Without a carrier, the actor defaults to <c>AuditActor.System(worker)</c>.
    /// </summary>
    /// <param name="carrier">The context captured with <see cref="IAuditLog.Carrier"/> when the job was enqueued.</param>
    /// <param name="jobId">The job id.</param>
    /// <param name="attempt">The attempt number, starting at 1.</param>
    /// <param name="worker">The worker or queue name; defaults to the service name.</param>
    IAuditLog ForJob(AuditCarrier? carrier, string? jobId = null, int? attempt = null, string? worker = null);
}

/// <summary>The per-request context captured by the Logbird middleware.</summary>
internal sealed class AuditRequestFeature
{
    public string OperationId { get; init; } = string.Empty;

    public string RequestId { get; init; } = string.Empty;

    public string? TraceId { get; init; }

    public string? Ip { get; init; }

    public string? UserAgent { get; init; }
}

/// <summary>The request-scoped <see cref="IAuditLog"/>.</summary>
internal sealed partial class RequestAuditLog(ILogbirdClient client, IHttpContextAccessor accessor, LogbirdRequestOptions options, ILogger<RequestAuditLog> logger)
    : IAuditLog
{
    public string Record(string action, Action<AuditEvent>? configure = null)
    {
        AuditEvent auditEvent;
        try
        {
            auditEvent = new AuditEvent(action ?? string.Empty);
            configure?.Invoke(auditEvent);
        }
        catch (Exception e)
        {
            // A throwing configure callback is the caller's bug; record what we can rather than throw into the request.
            LogConfigureFailed(logger, e.GetType().Name);
            auditEvent = new AuditEvent(action ?? string.Empty);
        }

        return RecordOwned(auditEvent);
    }

    // The caller's instance is never changed: reusing it for another Record must not reuse its id.
    public string Record(AuditEvent auditEvent) => auditEvent is null ? string.Empty : RecordOwned(Copy(auditEvent));

    internal static AuditEvent Copy(AuditEvent auditEvent)
    {
        try
        {
            return auditEvent.Clone();
        }
        catch (InvalidOperationException)
        {
            // Too deep to copy safely: the client drops it as invalid and reports it.
            return auditEvent;
        }
    }

    private string RecordOwned(AuditEvent auditEvent)
    {
        try
        {
            auditEvent.Id ??= LogbirdClient.NewEventId();
            auditEvent.OccurredAt ??= DateTimeOffset.UtcNow;
            var http = accessor.HttpContext;
            if (http is not null)
            {
                Fill(auditEvent, http);
            }

            auditEvent.Executor ??= AuditExecutor.Api(options.ServiceName);
            client.Track(auditEvent);
            return auditEvent.Id;
        }
        catch (Exception e)
        {
            LogRecordFailed(logger, e.GetType().Name);
            return auditEvent?.Id ?? string.Empty;
        }
    }

    public AuditCarrier Carrier(string? parentEventId = null)
    {
        try
        {
            var http = accessor.HttpContext;
            var feature = http?.Features.Get<AuditRequestFeature>();
            return new AuditCarrier
            {
                OperationId = feature?.OperationId ?? LogbirdClient.NewEventId(),
                RequestId = feature?.RequestId ?? http?.TraceIdentifier,
                TraceId = feature?.TraceId ?? RequestContext.CurrentTraceId(),
                ParentEventId = parentEventId,
                Actor = http is null ? null : Resolve(options.ResolveActor ?? DefaultActor, http),
                Impersonator = http is null || options.ResolveImpersonator is null ? null : Resolve(options.ResolveImpersonator, http),
                Tenant = http is null ? null : Resolve(options.ResolveTenant ?? DefaultTenant, http),
            };
        }
        catch (Exception e)
        {
            LogRecordFailed(logger, e.GetType().Name);
            return new AuditCarrier { OperationId = LogbirdClient.NewEventId(), ParentEventId = parentEventId };
        }
    }

    private void Fill(AuditEvent e, HttpContext http)
    {
        var feature = http.Features.Get<AuditRequestFeature>() ?? RequestContext.Capture(http, options);
        var context = e.Context;
        context.OperationId ??= feature.OperationId;
        context.RequestId ??= feature.RequestId;
        context.TraceId ??= feature.TraceId;
        context.Ip ??= feature.Ip;
        context.UserAgent ??= feature.UserAgent;
        e.Actor ??= Resolve(options.ResolveActor ?? DefaultActor, http);
        e.Tenant ??= Resolve(options.ResolveTenant ?? DefaultTenant, http);
        if (options.ResolveImpersonator is not null)
        {
            e.Impersonator ??= Resolve(options.ResolveImpersonator, http);
        }
    }

    private T? Resolve<T>(Func<HttpContext, T?> resolver, HttpContext http)
        where T : class
    {
        try
        {
            return resolver(http);
        }
        catch (Exception e)
        {
            LogResolverFailed(logger, typeof(T).Name, e.GetType().Name);
            return null;
        }
    }

    private AuditActor? DefaultActor(HttpContext http)
    {
        var user = http.User;
        if (user?.Identity?.IsAuthenticated != true)
        {
            return null;
        }

        var id = RequestContext.FirstClaim(user, options.ActorIdClaimTypes);
        if (string.IsNullOrEmpty(id))
        {
            return null;
        }

        return AuditActor.User(id!, RequestContext.FirstClaim(user, options.ActorNameClaimTypes), RequestContext.FirstClaim(user, options.ActorEmailClaimTypes));
    }

    private AuditTenant? DefaultTenant(HttpContext http)
    {
        var id = http.User is null ? null : RequestContext.FirstClaim(http.User, options.TenantIdClaimTypes);
        return string.IsNullOrEmpty(id) ? null : new AuditTenant(id!);
    }

    [LoggerMessage(EventId = 101, Level = LogLevel.Warning, Message = "Logbird: an audit event's configure callback threw {ExceptionType}; the event was recorded without it")]
    private static partial void LogConfigureFailed(ILogger logger, string exceptionType);

    [LoggerMessage(EventId = 102, Level = LogLevel.Warning, Message = "Logbird: recording an audit event failed with {ExceptionType}")]
    private static partial void LogRecordFailed(ILogger logger, string exceptionType);

    [LoggerMessage(EventId = 103, Level = LogLevel.Warning, Message = "Logbird: the {Kind} resolver threw {ExceptionType}; the event was recorded without it")]
    private static partial void LogResolverFailed(ILogger logger, string kind, string exceptionType);
}

/// <summary>An <see cref="IAuditLog"/> for one background job attempt.</summary>
internal sealed class JobAuditLog(ILogbirdClient client, AuditCarrier? carrier, AuditExecutor executor) : IAuditLog
{
    private readonly string _operationId = carrier?.OperationId ?? LogbirdClient.NewEventId();

    public string Record(string action, Action<AuditEvent>? configure = null)
    {
        var auditEvent = new AuditEvent(action ?? string.Empty);
        try
        {
            configure?.Invoke(auditEvent);
        }
        catch
        {
            auditEvent = new AuditEvent(action ?? string.Empty);
        }

        return RecordOwned(auditEvent);
    }

    public string Record(AuditEvent auditEvent) => auditEvent is null ? string.Empty : RecordOwned(RequestAuditLog.Copy(auditEvent));

    private string RecordOwned(AuditEvent auditEvent)
    {
        try
        {
            auditEvent.Id ??= LogbirdClient.NewEventId();
            auditEvent.OccurredAt ??= DateTimeOffset.UtcNow;
            auditEvent.Actor ??= carrier?.Actor ?? AuditActor.System(executor.Id ?? "worker");
            auditEvent.Impersonator ??= carrier?.Impersonator;
            auditEvent.Tenant ??= carrier?.Tenant;
            auditEvent.Executor ??= executor;
            var context = auditEvent.Context;
            context.OperationId ??= _operationId;
            context.RequestId ??= carrier?.RequestId;
            context.TraceId ??= carrier?.TraceId ?? RequestContext.CurrentTraceId();
            context.ParentEventId ??= carrier?.ParentEventId;
            client.Track(auditEvent);
            return auditEvent.Id;
        }
        catch
        {
            return auditEvent?.Id ?? string.Empty;
        }
    }

    public AuditCarrier Carrier(string? parentEventId = null) => new()
    {
        OperationId = _operationId,
        RequestId = carrier?.RequestId,
        TraceId = carrier?.TraceId,
        ParentEventId = parentEventId,
        Actor = carrier?.Actor,
        Impersonator = carrier?.Impersonator,
        Tenant = carrier?.Tenant,
    };
}

internal sealed class AuditLogFactory(ILogbirdClient client, LogbirdRequestOptions options) : IAuditLogFactory
{
    public IAuditLog ForJob(AuditCarrier? carrier, string? jobId = null, int? attempt = null, string? worker = null)
        => new JobAuditLog(client, carrier, AuditExecutor.Worker(worker ?? options.ServiceName ?? "worker", jobId, attempt));
}

/// <summary>Captures request details once per request.</summary>
internal static partial class RequestContext
{
    private const int MaxIdLength = 256;
    private const int MaxUserAgentLength = 1024;

    public static AuditRequestFeature Capture(HttpContext http, LogbirdRequestOptions options)
    {
        var headers = http.Request.Headers;
        var operation = options.UseOperationHeader ? Header(headers, "X-Logbird-Operation", MaxIdLength) : null;
        var requestId = options.UseRequestIdHeader ? Header(headers, "X-Request-Id", MaxIdLength) : null;
        return new AuditRequestFeature
        {
            OperationId = operation ?? LogbirdClient.NewEventId(),
            RequestId = requestId ?? http.TraceIdentifier,
            TraceId = CurrentTraceId() ?? TraceParent(Header(headers, "traceparent", 128)),
            Ip = http.Connection.RemoteIpAddress?.ToString(),
            UserAgent = Header(headers, "User-Agent", MaxUserAgentLength),
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

    public static string? FirstClaim(System.Security.Claims.ClaimsPrincipal user, System.Collections.Generic.IEnumerable<string> types)
    {
        foreach (var type in types)
        {
            var value = user.FindFirst(type)?.Value;
            if (!string.IsNullOrEmpty(value))
            {
                return value;
            }
        }

        return null;
    }

    private static string? TraceParent(string? header)
    {
        if (header is null)
        {
            return null;
        }

        var match = TraceParentPattern().Match(header);
        if (!match.Success || match.Groups[1].Value == "00000000000000000000000000000000" || match.Groups[2].Value == "0000000000000000")
        {
            return null;
        }

        return match.Groups[1].Value;
    }

    private static string? Header(IHeaderDictionary headers, string name, int maxLength)
    {
        if (!headers.TryGetValue(name, out var values) || values.Count != 1)
        {
            return null;
        }

        var value = values[0];
        if (string.IsNullOrEmpty(value))
        {
            return null;
        }

        return value!.Length > maxLength ? value.Substring(0, maxLength) : value;
    }

    [GeneratedRegex("^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 100)]
    private static partial Regex TraceParentPattern();
}
