using System;
using System.Globalization;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Logbird;
using Logbird.AspNetCore;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Microsoft.Extensions.DependencyInjection;

/// <summary>Registers Logbird in an ASP.NET Core or generic-host application.</summary>
public static class LogbirdServiceCollectionExtensions
{
    /// <summary>The name of the <see cref="HttpClient"/> Logbird sends with (configure it with <c>AddHttpClient(LogbirdHttpClientName)</c>).</summary>
    public const string LogbirdHttpClientName = "Logbird";

    /// <summary>
    /// Registers a singleton <see cref="ILogbirdClient"/>, a scoped <see cref="IAuditLog"/>, an <see cref="IAuditLogFactory"/>
    /// for background jobs, and a hosted service that sends what is queued when the host stops.
    /// </summary>
    /// <param name="services">The services.</param>
    /// <param name="configure">Sets the client options (endpoint, ingest key, batching, redaction, callbacks).</param>
    /// <param name="configureRequests">Optionally changes how requests fill the audit context.</param>
    /// <example>
    /// <code>
    /// builder.Services.AddLogbird(o =>
    /// {
    ///     o.Endpoint = new Uri("https://audit.example.com");
    ///     o.IngestKey = builder.Configuration["Logbird:IngestKey"];
    /// });
    /// </code>
    /// </example>
    public static IServiceCollection AddLogbird(this IServiceCollection services, Action<LogbirdOptions> configure, Action<LogbirdRequestOptions>? configureRequests = null)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configure);
        var options = new LogbirdOptions();
        configure(options);
        return services.AddLogbirdCore(options, configureRequests);
    }

    /// <summary>
    /// Registers Logbird from a configuration section, for example <c>builder.Configuration.GetSection("Logbird")</c> with
    /// <c>Endpoint</c>, <c>IngestKey</c>, <c>Enabled</c>, <c>Environment</c>, <c>Source</c>, <c>BatchSize</c>,
    /// <c>FlushInterval</c>, <c>MaxRetries</c>, <c>MaxQueueSize</c>, <c>QueueFullBehavior</c>, <c>ShutdownTimeout</c>,
    /// <c>RequestTimeout</c>, <c>AllowInsecureHttp</c> and <c>RedactKeys</c> (comma-separated names added to the secret pattern).
    /// <paramref name="configure"/> runs afterwards for anything configuration cannot express, such as callbacks.
    /// </summary>
    /// <param name="services">The services.</param>
    /// <param name="section">The configuration section.</param>
    /// <param name="configure">Adjusts the options after binding.</param>
    /// <param name="configureRequests">Optionally changes how requests fill the audit context.</param>
    public static IServiceCollection AddLogbird(
        this IServiceCollection services,
        IConfiguration section,
        Action<LogbirdOptions>? configure = null,
        Action<LogbirdRequestOptions>? configureRequests = null)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(section);
        var options = Bind(section);
        configure?.Invoke(options);
        return services.AddLogbirdCore(options, configureRequests);
    }

    private static IServiceCollection AddLogbirdCore(this IServiceCollection services, LogbirdOptions options, Action<LogbirdRequestOptions>? configureRequests)
    {
        // Fail at startup, not on the first event.
        options.ValidateForHost();
        services.AddHttpContextAccessor();

        // A long-lived client: connections are recycled by the handler, and redirects are never followed (they could
        // forward the audit body to another origin).
        services.AddHttpClient(LogbirdHttpClientName, client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5), AllowAutoRedirect = false })
            .SetHandlerLifetime(Timeout.InfiniteTimeSpan);

        services.TryAddSingleton(provider =>
        {
            var requestOptions = new LogbirdRequestOptions();
            requestOptions.ServiceName = provider.GetService<IHostEnvironment>()?.ApplicationName;
            configureRequests?.Invoke(requestOptions);
            return requestOptions;
        });
        services.TryAddSingleton<LogbirdClient>(provider => new LogbirdClient(
            options,
            provider.GetRequiredService<IHttpClientFactory>().CreateClient(LogbirdHttpClientName),
            provider.GetService<ILoggerFactory>()?.CreateLogger("Logbird")));
        services.TryAddSingleton<ILogbirdClient>(provider => provider.GetRequiredService<LogbirdClient>());
        services.TryAddScoped<IAuditLog, RequestAuditLog>();
        services.TryAddSingleton<IAuditLogFactory, AuditLogFactory>();
        services.AddHostedService<LogbirdShutdown>();
        return services;
    }

    // The same checks the client runs, without starting one.
    private static void ValidateForHost(this LogbirdOptions options) => options.Validate();

    private static LogbirdOptions Bind(IConfiguration section)
    {
        // Explicit reads instead of reflection-based binding: trimming and Native AOT safe.
        var options = new LogbirdOptions();
        if (section["Endpoint"] is { Length: > 0 } endpoint)
        {
            options.Endpoint = new Uri(endpoint, UriKind.Absolute);
        }

        options.IngestKey = section["IngestKey"] ?? options.IngestKey;
        options.Environment = section["Environment"] ?? options.Environment;
        options.Source = section["Source"] ?? options.Source;
        options.Enabled = Bool(section, "Enabled") ?? options.Enabled;
        options.AllowInsecureHttp = Bool(section, "AllowInsecureHttp") ?? options.AllowInsecureHttp;
        options.BatchSize = Int(section, "BatchSize") ?? options.BatchSize;
        options.MaxRetries = Int(section, "MaxRetries") ?? options.MaxRetries;
        options.MaxQueueSize = Int(section, "MaxQueueSize") ?? options.MaxQueueSize;
        options.FlushInterval = Time(section, "FlushInterval") ?? options.FlushInterval;
        options.ShutdownTimeout = Time(section, "ShutdownTimeout") ?? options.ShutdownTimeout;
        options.RequestTimeout = Time(section, "RequestTimeout") ?? options.RequestTimeout;
        if (section["QueueFullBehavior"] is { Length: > 0 } behavior)
        {
            options.QueueFullBehavior = Enum.Parse<QueueFullBehavior>(behavior, ignoreCase: true);
        }

        if (section["RedactKeys"] is { Length: > 0 } keys)
        {
            options.Redaction.AddKeys(keys.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        }

        return options;
    }

    private static bool? Bool(IConfiguration section, string key) => section[key] is { Length: > 0 } value ? bool.Parse(value) : null;

    private static int? Int(IConfiguration section, string key) => section[key] is { Length: > 0 } value ? int.Parse(value, CultureInfo.InvariantCulture) : null;

    private static TimeSpan? Time(IConfiguration section, string key) => section[key] is { Length: > 0 } value ? TimeSpan.Parse(value, CultureInfo.InvariantCulture) : null;
}

/// <summary>Adds the Logbird request context to the pipeline.</summary>
public static class LogbirdApplicationBuilderExtensions
{
    /// <summary>
    /// Captures each request's audit context (operation, request and trace ids, IP, user agent) for <see cref="IAuditLog"/>.
    /// Add it after <c>UseForwardedHeaders</c> (so the client IP is right) and before your endpoints. The actor and tenant
    /// are read from the signed-in user when an event is recorded, so the order relative to authentication does not matter.
    /// </summary>
    /// <param name="app">The application builder.</param>
    public static IApplicationBuilder UseLogbird(this IApplicationBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        return app.UseMiddleware<LogbirdMiddleware>();
    }
}

/// <summary>Captures the request's audit context once per request.</summary>
internal sealed class LogbirdMiddleware(RequestDelegate next, LogbirdRequestOptions options)
{
    public Task InvokeAsync(HttpContext context)
    {
        try
        {
            context.Features.Set(RequestContext.Capture(context, options));
        }
        catch
        {
            // Audit context is best effort; the request must go on.
        }

        return next(context);
    }
}

/// <summary>Sends what is queued when the host stops, within the host's shutdown budget.</summary>
internal sealed class LogbirdShutdown(LogbirdClient client) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        // DisposeAsync is bounded by ShutdownTimeout and reports anything unsent through OnDrop; it never throws.
        var dispose = client.DisposeAsync().AsTask();
        await Task.WhenAny(dispose, Task.Delay(Timeout.Infinite, cancellationToken)).ConfigureAwait(false);
    }
}
