using System;
using System.Collections.Concurrent;
using System.Net;
using System.Net.Http;
using System.Security.Claims;
using System.Threading.Tasks;
using Logbird.IntegrationTests;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Xunit.Abstractions;

namespace Logbird.AspNetCore.Tests;

/// <summary>The ASP.NET Core integration against a real Logbird server (skipped unless <c>LOGBIRD_IT_*</c> is set).</summary>
public class LiveAspNetCoreTests(ITestOutputHelper output)
{
    [LiveFact]
    public async Task A_request_and_the_job_it_starts_read_back_with_their_context_after_the_host_stops()
    {
        var operation = "op_" + Guid.NewGuid().ToString("N");
        var invoice = "inv_" + Guid.NewGuid().ToString("N")[..12];
        const string TraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
        var errors = new ConcurrentQueue<Exception>();
        var drops = new ConcurrentQueue<DroppedEvent>();

        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddLogbird(
            o =>
            {
                var live = LiveServer.Options();
                o.Endpoint = live.Endpoint;
                o.IngestKey = live.IngestKey;
                o.Environment = live.Environment;
                o.Source = live.Source;
                o.FlushInterval = TimeSpan.FromHours(1);
                o.OnError = errors.Enqueue;
                o.OnDrop = drops.Enqueue;
            },
            r =>
            {
                r.ServiceName = "billing-api";
                r.ActorEmailClaimTypes.Add("email");
                r.UseRequestIdHeader = true;
                r.UseOperationHeader = true;
            });
        var app = builder.Build();
        app.Use((context, next) =>
        {
            context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.10");
            context.User = new ClaimsPrincipal(new ClaimsIdentity(
                [new Claim("sub", "user_live_1"), new Claim("name", "Fictional Live User"), new Claim("email", "live.user@example.invalid"), new Claim("tenant_id", "acct_live")],
                "test"));
            return next(context);
        });
        app.UseLogbird();
        app.MapPost("/invoices/{id}", (string id, IAuditLog audit, IAuditLogFactory jobs) =>
        {
            var updated = audit.Record("invoice.updated", e => e.Target("invoice", id).Change("status", "draft", "sent"));
            var carrier = audit.Carrier(updated);

            // The worker side: normally the carrier travels in the job payload.
            var emailed = jobs.ForJob(carrier, jobId: "job_live", attempt: 1, worker: "billing-worker").Record("invoice.emailed", e => e.Target("invoice", id));
            return Results.Text(updated + "," + emailed);
        });
        await app.StartAsync();

        using var request = new HttpRequestMessage(HttpMethod.Post, "/invoices/" + invoice);
        request.Headers.Add("X-Request-Id", "req_live_1");
        request.Headers.Add("X-Logbird-Operation", operation);
        request.Headers.Add("traceparent", $"00-{TraceId}-00f067aa0ba902b7-01");
        request.Headers.UserAgent.ParseAdd("Fictional-Live/1.0");
        var response = await app.GetTestClient().SendAsync(request);
        response.EnsureSuccessStatusCode();
        var ids = (await response.Content.ReadAsStringAsync()).Split(',');

        // No explicit flush: stopping the host sends what is queued.
        await app.StopAsync();
        await app.DisposeAsync();
        Assert.Empty(errors);
        Assert.Empty(drops);

        using var reader = LiveServer.Reader();
        var updated = (await LiveServer.WaitForEventAsync(reader, ids[0])).Event;
        var emailed = (await LiveServer.WaitForEventAsync(reader, ids[1])).Event;

        var actor = AuditActor.User("user_live_1", "Fictional Live User", "live.user@example.invalid");
        Assert.Equal("invoice.updated", updated.Action);
        Assert.Equal("integration", updated.Environment);
        Assert.Equal(actor, updated.Actor);
        AssertTenant(updated.Tenant);
        AssertExecutor(updated.Executor, "api", "billing-api", null, null);
        Assert.Equal([new AuditTarget("invoice", invoice) { Name = string.Empty }], updated.Targets);
        Assert.Equal([new StoredChange("status", "draft", "sent")], updated.Changes);
        Assert.Equal(operation, updated.Context.OperationId);
        Assert.Equal("req_live_1", updated.Context.RequestId);
        Assert.Equal(TraceId, updated.Context.TraceId);
        Assert.Equal("203.0.113.10", updated.Context.Ip);
        Assert.Equal("Fictional-Live/1.0", updated.Context.UserAgent);

        Assert.Equal("invoice.emailed", emailed.Action);
        Assert.Equal(actor, emailed.Actor);
        AssertTenant(emailed.Tenant);
        AssertExecutor(emailed.Executor, "worker", "billing-worker", "job_live", 1);
        Assert.Equal(operation, emailed.Context.OperationId);
        Assert.Equal(ids[0], emailed.Context.ParentEventId);
        Assert.Equal("req_live_1", emailed.Context.RequestId);
        Assert.Equal(TraceId, emailed.Context.TraceId);
        output.WriteLine($"read back {ids[0]} and {ids[1]} in operation {operation}");
    }

    // The records print no values, so compare the fields (the server stores absent names as "" and attempts as 0).
    private static void AssertTenant(AuditTenant? tenant)
    {
        Assert.NotNull(tenant);
        Assert.Equal("acct_live", tenant.Id);
        Assert.True(string.IsNullOrEmpty(tenant.Name));
    }

    private static void AssertExecutor(AuditExecutor? executor, string type, string id, string? jobId, int? attempt)
    {
        Assert.NotNull(executor);
        Assert.Equal(type, executor.Type);
        Assert.Equal(id, executor.Id);
        Assert.Equal(jobId, string.IsNullOrEmpty(executor.JobId) ? null : executor.JobId);
        Assert.Equal(attempt ?? 0, executor.Attempt ?? 0);
    }
}
