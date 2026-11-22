using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using Logbird.AspNetCore;

namespace Logbird.Example.AspNetCore;

/// <summary>Fictional users. A real application checks a password hash in its user store.</summary>
internal static class DemoUsers
{
    private static readonly DemoUser[] Users =
    [
        new("user_ana", "Ana Fictional", "ana@example.com", "acct_acme", "correct-horse"),
        new("user_ben", "Ben Fictional", "ben@example.com", "acct_globex", "battery-staple"),
    ];

    public static DemoUser? Find(string email, string password)
        => Users.FirstOrDefault(u => string.Equals(u.Email, email, StringComparison.OrdinalIgnoreCase) && u.Password == password);
}

internal sealed record DemoUser(string Id, string Name, string Email, string TenantId, string Password);

/// <summary>An in-memory invoice table, scoped by tenant. A real application uses its database.</summary>
internal sealed class InvoiceStore
{
    private readonly ConcurrentDictionary<(string Tenant, string Id), string> _status = new()
    {
        [("acct_acme", "inv_1001")] = "draft",
        [("acct_acme", "inv_1002")] = "sent",
        [("acct_globex", "inv_2001")] = "draft",
    };

    public bool Exists(string? tenant, string id) => tenant is not null && _status.ContainsKey((tenant, id));

    /// <summary>Changes the status and returns the value before and after, or null when the invoice is not in the tenant.</summary>
    public (string Before, string After)? SetStatus(string? tenant, string id, string status)
    {
        if (tenant is null)
        {
            return null;
        }

        while (_status.TryGetValue((tenant, id), out var before))
        {
            if (_status.TryUpdate((tenant, id), status, before))
            {
                return (before, status);
            }
        }

        return null;
    }
}

/// <summary>
/// A stand-in for your job queue (Hangfire, a message broker, an outbox table). The audit carrier travels in the job
/// payload as JSON, exactly as it would through a real queue.
/// </summary>
internal sealed class InvoiceEmailQueue
{
    private readonly Channel<string> _jobs = Channel.CreateUnbounded<string>();

    public ChannelReader<string> Reader => _jobs.Reader;

    public string Enqueue(string invoiceId, AuditCarrier carrier)
    {
        var job = new InvoiceEmailJob("job_" + Guid.NewGuid().ToString("N")[..12], invoiceId, carrier);
        _jobs.Writer.TryWrite(JsonSerializer.Serialize(job, ExampleJsonContext.Default.InvoiceEmailJob));
        return job.JobId;
    }
}

internal sealed record InvoiceEmailJob(string JobId, string InvoiceId, AuditCarrier Carrier);

/// <summary>Sends invoice emails in the background and records each one in the same operation as the request.</summary>
internal sealed partial class InvoiceEmailWorker(InvoiceEmailQueue queue, IAuditLogFactory audits, ILogger<InvoiceEmailWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var payload in queue.Reader.ReadAllAsync(stoppingToken))
        {
            var job = JsonSerializer.Deserialize(payload, ExampleJsonContext.Default.InvoiceEmailJob);
            if (job is null)
            {
                continue;
            }

            // The job's events keep the request's actor, tenant and operation; the executor is this worker.
            var audit = audits.ForJob(job.Carrier, job.JobId, attempt: 1, worker: "invoice-mailer");

            // ... send the email here ...
            audit.Record("invoice.emailed", e => e.Target("invoice", job.InvoiceId));
            LogSent(logger, job.JobId);
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Invoice email job {JobId} done")]
    private static partial void LogSent(ILogger logger, string jobId);
}

[System.Text.Json.Serialization.JsonSerializable(typeof(InvoiceEmailJob))]
[System.Text.Json.Serialization.JsonSourceGenerationOptions(PropertyNamingPolicy = System.Text.Json.Serialization.JsonKnownNamingPolicy.CamelCase)]
internal sealed partial class ExampleJsonContext : System.Text.Json.Serialization.JsonSerializerContext
{
}
