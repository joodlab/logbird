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
    /// Registers an <see cref="ILogbirdClient"/>, a scoped <see cref="IAuditLog"/>, an <see cref="IAuditLogFactory"/> for
    /// background jobs, and a hosted service that sends what is queued when the host stops. Call it once; later calls do
    /// not change the registered client.
    /// </summary>
    /// <param name="services">The services.</param>
    /// <param name="configure">Sets the client options (endpoint, ingest key, batching, redaction, callbacks).</param>
    /// <param name="configureRequests">Optionally changes how requests fill the audit context. Runs during this call.</param>
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
    /// <param name="configureRequests">Optionally changes how requests fill the audit context. Runs during this call.</param>
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
        // Fail at startup, not on the first event or job: the options are checked and the request callback runs now.
        options.Validate();
        var requestOptions = new LogbirdRequestOptions();
        configureRequests?.Invoke(requestOptions);
        services.AddHttpContextAccessor();

        // A long-lived client: connections are recycled by the handler, redirects are never followed by this handler
        // (they could forward the audit body to another origin), and the factory's request logging never prints header
        // values, so the Authorization header cannot reach a log on any runtime.
        services.AddHttpClient(LogbirdHttpClientName, client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5), AllowAutoRedirect = false })
            .SetHandlerLifetime(Timeout.InfiniteTimeSpan)
            .RedactLoggedHeaders(static _ => true);

        services.TryAddSingleton(provider =>
        {
            requestOptions.ServiceName ??= provider.GetService<IHostEnvironment>()?.ApplicationName;
            return requestOptions;
        });
        services.TryAddSingleton(provider => new LogbirdClientOwner(new LogbirdClient(
            options,
            provider.GetRequiredService<IHttpClientFactory>().CreateClient(LogbirdHttpClientName),
            provider.GetService<ILoggerFactory>()?.CreateLogger("Logbird"))));

        // Not disposable: the owner alone decides how shutdown waits, so disposing the container cannot wait again.
        services.TryAddSingleton<ILogbirdClient>(provider => new HostedLogbirdClient(provider.GetRequiredService<LogbirdClientOwner>().Client));
        services.TryAddScoped<IAuditLog, RequestAuditLog>();
        services.TryAddSingleton<IAuditLogFactory, AuditLogFactory>();
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, LogbirdShutdown>());
        return services;
    }

    private static LogbirdOptions Bind(IConfiguration section)
    {
        // Explicit reads instead of reflection-based binding: trimming and Native AOT safe.
        var options = new LogbirdOptions();
        if (section["Endpoint"] is { Length: > 0 } endpoint)
        {
            options.Endpoint = Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) ? uri : throw Invalid("Endpoint", "an absolute URL");
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
            options.QueueFullBehavior = Enum.TryParse<QueueFullBehavior>(behavior, ignoreCase: true, out var parsed) && Enum.IsDefined(parsed)
                ? parsed
                : throw Invalid("QueueFullBehavior", "DropOldest or DropNewest");
        }

        if (section["RedactKeys"] is { Length: > 0 } keys)
        {
            options.Redaction.AddKeys(keys.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        }

        return options;
    }

    private static bool? Bool(IConfiguration section, string key)
        => section[key] is not { Length: > 0 } value ? null : bool.TryParse(value, out var result) ? result : throw Invalid(key, "true or false");

    private static int? Int(IConfiguration section, string key)
        => section[key] is not { Length: > 0 } value ? null
            : int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var result) ? result : throw Invalid(key, "a whole number");

    private static TimeSpan? Time(IConfiguration section, string key)
        => section[key] is not { Length: > 0 } value ? null
            : TimeSpan.TryParse(value, CultureInfo.InvariantCulture, out var result) ? result : throw Invalid(key, "a time span such as 00:00:05");

    // Names the setting but never echoes its value: a misplaced key or URL with credentials must not reach startup logs.
    private static ArgumentException Invalid(string key, string expected)
        => new($"Logbird configuration: '{key}' must be {expected}. The value is not shown.");
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
