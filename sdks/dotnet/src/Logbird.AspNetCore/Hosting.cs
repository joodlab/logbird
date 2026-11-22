using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;

namespace Logbird.AspNetCore;

/// <summary>Owns the client: shutdown waits once, within the host's budget, and the container never waits again.</summary>
internal sealed class LogbirdClientOwner(LogbirdClient client) : IAsyncDisposable, IDisposable
{
    private int _hostStopping;

    public LogbirdClient Client { get; } = client;

    /// <summary>Sends what is queued, within <see cref="LogbirdOptions.ShutdownTimeout"/> and the host's own token.</summary>
    public async Task StopForHostAsync(CancellationToken cancellationToken)
    {
        Volatile.Write(ref _hostStopping, 1);
        try
        {
            await Client.DisposeAsync().AsTask().WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // The host's budget ran out first: report everything still unsent now rather than outlive the host.
            Client.AbandonNow();
        }
    }

    public ValueTask DisposeAsync()
    {
        if (Volatile.Read(ref _hostStopping) == 1)
        {
            // The host already stopped Logbird within its budget; whatever is left is reported now, without waiting.
            Client.AbandonNow();
            return default;
        }

        // No host stopped it (a plain service provider): the client's own bounded shutdown.
        return Client.DisposeAsync();
    }

    public void Dispose()
    {
        if (Volatile.Read(ref _hostStopping) == 1)
        {
            Client.AbandonNow();
            return;
        }

        Client.Dispose();
    }
}

/// <summary>The registered <see cref="ILogbirdClient"/>: the owner's client, without a way to dispose it.</summary>
internal sealed class HostedLogbirdClient(LogbirdClient client) : ILogbirdClient
{
    public LogbirdStats Stats => client.Stats;

    public void Track(AuditEvent auditEvent) => client.Track(auditEvent);

    public Task<bool> FlushAsync(CancellationToken cancellationToken = default) => client.FlushAsync(cancellationToken);
}

/// <summary>Captures the request's audit context once per request.</summary>
internal sealed class LogbirdMiddleware(RequestDelegate next, LogbirdRequestOptions options, LogbirdClientOwner owner)
{
    public Task InvokeAsync(HttpContext context)
    {
        try
        {
            // Get-or-create: a re-executed pipeline (an exception handler) keeps the request's first operation id.
            RequestContext.GetOrCapture(context, options, owner.Client);
        }
        catch
        {
            // Audit context is best effort; the request must go on. Capture reports its own problems.
        }

        return next(context);
    }
}

/// <summary>Sends what is queued when the host stops, within the host's shutdown budget.</summary>
internal sealed class LogbirdShutdown(LogbirdClientOwner owner) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => owner.StopForHostAsync(cancellationToken);
}
