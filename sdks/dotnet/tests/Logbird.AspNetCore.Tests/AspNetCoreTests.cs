using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Claims;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Logbird.AspNetCore;
using Logbird.Tests;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Logbird.AspNetCore.Tests;

public class AspNetCoreTests
{
    private sealed class App : IAsyncDisposable
    {
        private App(WebApplication app, FakeServer server)
        {
            Host = app;
            Server = server;
            Http = app.GetTestClient();
        }

        public WebApplication Host { get; }

        public FakeServer Server { get; }

        public HttpClient Http { get; }

        public ILogbirdClient Client => Host.Services.GetRequiredService<ILogbirdClient>();

        public static async Task<App> StartAsync(
            Action<WebApplication> map,
            Action<LogbirdRequestOptions>? requests = null,
            Action<LogbirdOptions>? options = null,
            ClaimsPrincipal? user = null)
        {
            var server = new FakeServer();
            var builder = WebApplication.CreateBuilder();
            builder.WebHost.UseTestServer();
            builder.Services.AddLogbird(
                o =>
                {
                    o.Endpoint = new Uri("https://audit.example.invalid");
                    o.IngestKey = "lb_ingest_fictional";
                    o.FlushInterval = TimeSpan.FromHours(1);
                    options?.Invoke(o);
                },
                requests);

            // Applications customize Logbird's HTTP client the same way.
            builder.Services.AddHttpClient(LogbirdServiceCollectionExtensions.LogbirdHttpClientName).ConfigurePrimaryHttpMessageHandler(() => server);
            var app = builder.Build();
            app.Use((context, next) =>
            {
                context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.9");
                if (user is not null)
                {
                    context.User = user;
                }

                return next(context);
            });
            app.UseLogbird();
            map(app);
            await app.StartAsync();
            return new App(app, server);
        }

        public async Task<JsonElement[]> FlushedEventsAsync()
        {
            Assert.True(await Client.FlushAsync());
            return Server.Requests.SelectMany(r => r.Events).ToArray();
        }

        public async ValueTask DisposeAsync()
        {
            await Host.StopAsync();
            await Host.DisposeAsync();
        }
    }

    private static ClaimsPrincipal User(params (string Type, string Value)[] claims)
        => new(new ClaimsIdentity(claims.Select(c => new Claim(c.Type, c.Value)), "test"));

    [Fact]
    public async Task Events_recorded_in_a_request_carry_the_request_context()
    {
        await using var app = await App.StartAsync(
            a => a.MapPut("/invoices/{id}", (string id, IAuditLog audit) =>
            {
                audit.Record("invoice.updated", e => e.Target("invoice", id).Change("status", "draft", "sent"));
                return Results.NoContent();
            }),
            requests: r => r.ServiceName = "billing-api",
            user: User(("sub", "user_42"), ("name", "Fictional User"), ("email", "fictional@example.invalid"), ("tenant_id", "acct_7")));
        using var request = new HttpRequestMessage(HttpMethod.Put, "/invoices/inv_1");
        request.Headers.Add("X-Request-Id", "req_1");
        request.Headers.Add("X-Logbird-Operation", "op_1");
        request.Headers.Add("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
        request.Headers.UserAgent.ParseAdd("Fictional/1.0");
        Assert.Equal(HttpStatusCode.NoContent, (await app.Http.SendAsync(request)).StatusCode);

        var e = Assert.Single(await app.FlushedEventsAsync());
        Assert.Equal("invoice.updated", e.GetProperty("action").GetString());
        Assert.Equal("user", e.GetProperty("actor").GetProperty("type").GetString());
        Assert.Equal("user_42", e.GetProperty("actor").GetProperty("id").GetString());
        Assert.Equal("Fictional User", e.GetProperty("actor").GetProperty("name").GetString());
        Assert.False(e.GetProperty("actor").TryGetProperty("email", out _), "email is opt-in");
        Assert.Equal("acct_7", e.GetProperty("tenant").GetProperty("id").GetString());
        Assert.Equal("api", e.GetProperty("executor").GetProperty("type").GetString());
        Assert.Equal("billing-api", e.GetProperty("executor").GetProperty("id").GetString());
        var context = e.GetProperty("context");
        Assert.Equal("op_1", context.GetProperty("operationId").GetString());
        Assert.Equal("req_1", context.GetProperty("requestId").GetString());
        Assert.Equal("203.0.113.9", context.GetProperty("ip").GetString());
        Assert.Equal("Fictional/1.0", context.GetProperty("userAgent").GetString());
        Assert.Matches("^[0-9a-f]{32}$", context.GetProperty("traceId").GetString());
    }

    [Fact]
    public async Task Values_set_on_the_event_win_and_anonymous_requests_have_no_actor()
    {
        await using var app = await App.StartAsync(a => a.MapPost("/signin", (IAuditLog audit) =>
        {
            audit.Record("session.failed");
            audit.Record("session.started", e =>
            {
                e.Actor = AuditActor.User("explicit_user");
                e.Context.RequestId = "explicit_request";
            });
            return Results.Ok();
        }));
        (await app.Http.PostAsync("/signin", null)).EnsureSuccessStatusCode();
        var events = await app.FlushedEventsAsync();
        Assert.False(events[0].TryGetProperty("actor", out _));
        Assert.Equal("explicit_user", events[1].GetProperty("actor").GetProperty("id").GetString());
        Assert.Equal("explicit_request", events[1].GetProperty("context").GetProperty("requestId").GetString());
        Assert.Equal(events[0].GetProperty("context").GetProperty("operationId").GetString(), events[1].GetProperty("context").GetProperty("operationId").GetString());
    }

    [Fact]
    public async Task Claim_types_and_resolvers_are_configurable_and_a_throwing_resolver_never_fails_the_request()
    {
        await using var app = await App.StartAsync(
            a => a.MapGet("/", (IAuditLog audit) =>
            {
                audit.Record("page.viewed");
                return Results.Ok();
            }),
            requests: r =>
            {
                r.ActorIdClaimTypes.Clear();
                r.ActorIdClaimTypes.Add("uid");
                r.ResolveTenant = _ => throw new InvalidOperationException("fictional resolver bug");
                r.ResolveImpersonator = http => http.User.FindFirst("act") is { } act ? new AuditImpersonator(act.Value) : null;
            },
            user: User(("uid", "u_custom"), ("act", "support_1"), ("tenant_id", "ignored")));
        (await app.Http.GetAsync("/")).EnsureSuccessStatusCode();
        var e = Assert.Single(await app.FlushedEventsAsync());
        Assert.Equal("u_custom", e.GetProperty("actor").GetProperty("id").GetString());
        Assert.Equal("support_1", e.GetProperty("impersonator").GetProperty("id").GetString());
        Assert.False(e.TryGetProperty("tenant", out _));
    }

    [Fact]
    public async Task A_background_job_continues_the_requests_operation_with_the_same_actor()
    {
        AuditCarrier? carrier = null;
        string? requestEventId = null;
        await using var app = await App.StartAsync(
            a => a.MapPost("/sync", (IAuditLog audit) =>
            {
                requestEventId = audit.Record("crm.sync.requested");
                carrier = audit.Carrier(requestEventId);
                return Results.Accepted();
            }),
            user: User(("sub", "user_42"), ("tenant_id", "acct_7")));
        (await app.Http.PostAsync("/sync", null)).EnsureSuccessStatusCode();

        // The carrier travels in the job payload.
        var payload = JsonSerializer.Serialize(carrier!, AuditCarrierJsonContext.Default.AuditCarrier);
        var restored = JsonSerializer.Deserialize(payload, AuditCarrierJsonContext.Default.AuditCarrier);
        var job = app.Host.Services.GetRequiredService<IAuditLogFactory>().ForJob(restored, jobId: "job_1", attempt: 2, worker: "crm-worker");
        job.Record("guest.updated", e => e.Target("guest", "g_1"));

        var events = await app.FlushedEventsAsync();
        var worker = events.Single(e => e.GetProperty("action").GetString() == "guest.updated");
        Assert.Equal("user_42", worker.GetProperty("actor").GetProperty("id").GetString());
        Assert.Equal("acct_7", worker.GetProperty("tenant").GetProperty("id").GetString());
        Assert.Equal("worker", worker.GetProperty("executor").GetProperty("type").GetString());
        Assert.Equal("crm-worker", worker.GetProperty("executor").GetProperty("id").GetString());
        Assert.Equal("job_1", worker.GetProperty("executor").GetProperty("jobId").GetString());
        Assert.Equal(2, worker.GetProperty("executor").GetProperty("attempt").GetInt32());
        Assert.Equal(requestEventId, worker.GetProperty("context").GetProperty("parentEventId").GetString());
        Assert.Equal(
            events.Single(e => e.GetProperty("action").GetString() == "crm.sync.requested").GetProperty("context").GetProperty("operationId").GetString(),
            worker.GetProperty("context").GetProperty("operationId").GetString());
    }

    [Fact]
    public async Task Scheduled_work_without_a_carrier_uses_a_system_actor()
    {
        await using var app = await App.StartAsync(_ => { });
        app.Host.Services.GetRequiredService<IAuditLogFactory>().ForJob(null, worker: "nightly-billing").Record("invoices.closed");
        var e = Assert.Single(await app.FlushedEventsAsync());
        Assert.Equal("system", e.GetProperty("actor").GetProperty("type").GetString());
        Assert.Equal("nightly-billing", e.GetProperty("actor").GetProperty("id").GetString());
    }

    [Fact]
    public async Task Recording_a_prepared_event_never_changes_the_callers_instance()
    {
        var prepared = new AuditEvent("reused");
        await using var app = await App.StartAsync(a => a.MapPost("/twice", (IAuditLog audit) =>
        {
            audit.Record(prepared);
            audit.Record(prepared);
            return Results.Ok();
        }));
        (await app.Http.PostAsync("/twice", null)).EnsureSuccessStatusCode();
        var events = await app.FlushedEventsAsync();
        Assert.Null(prepared.Id);
        Assert.NotEqual(events[0].GetProperty("id").GetString(), events[1].GetProperty("id").GetString());
    }

    [Fact]
    public async Task A_prepared_event_too_deep_to_copy_is_reported_and_the_callers_instance_is_left_alone()
    {
        JsonNode tree = new JsonObject { ["leaf"] = true };
        for (var i = 0; i < 100_000; i++)
        {
            tree = new JsonObject { ["n"] = tree };
        }

        var prepared = new AuditEvent("deep") { Metadata = { ["tree"] = tree } };
        var drops = new List<DropReason>();
        await using var app = await App.StartAsync(
            a => a.MapPost("/deep", (IAuditLog audit) => Results.Text(audit.Record(prepared))),
            options: o => o.OnDrop = d => { lock (drops) { drops.Add(d.Reason); } });
        (await app.Http.PostAsync("/deep", null)).EnsureSuccessStatusCode();
        await app.Client.FlushAsync();
        Assert.Null(prepared.Id);
        Assert.Null(prepared.Actor);
        Assert.Null(prepared.Executor);
        Assert.Empty(app.Server.Requests);
        Assert.Equal(1, app.Client.Stats.Dropped);
        // OnDrop runs on the client's background notifier.
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            lock (drops)
            {
                if (drops.Count > 0)
                {
                    break;
                }
            }

            await Task.Delay(20);
        }

        lock (drops)
        {
            Assert.Equal([DropReason.Invalid], drops);
        }
    }

    [Fact]
    public async Task Stopping_the_host_returns_when_the_hosts_budget_runs_out_even_if_the_server_hangs()
    {
        var server = new FakeServer { Fallback = _ => new TaskCompletionSource<HttpResponseMessage>().Task };
        var client = new LogbirdClient(
            new LogbirdOptions
            {
                Endpoint = new Uri("https://audit.example.invalid"),
                IngestKey = "lb_ingest_fictional",
                FlushInterval = TimeSpan.FromHours(1),
                ShutdownTimeout = TimeSpan.FromSeconds(3),
            },
            new HttpClient(server));
        client.Track(new AuditEvent("stuck.recorded"));
        var shutdown = new LogbirdShutdown(client);
        using var budget = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        var watch = Stopwatch.StartNew();
        await shutdown.StopAsync(budget.Token);
        // The host's 200 ms budget wins over the client's 3 s ShutdownTimeout; the client then finishes on its own.
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(2), watch.Elapsed.ToString());
        await client.DisposeAsync();
        Assert.Equal(1, client.Stats.Dropped);
    }

    [Fact]
    public async Task Stopping_the_host_sends_what_is_queued()
    {
        var app = await App.StartAsync(a => a.MapPost("/", (IAuditLog audit) =>
        {
            for (var i = 0; i < 25; i++)
            {
                audit.Record("bulk.recorded");
            }

            return Results.Ok();
        }));
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        Assert.Empty(app.Server.Requests);
        await app.Host.StopAsync();
        Assert.Equal(25, app.Server.Requests.SelectMany(r => r.Events).Count());
        await app.Host.DisposeAsync();
    }

    [Fact]
    public void Configuration_binds_without_reflection_and_bad_settings_fail_at_startup()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Logbird:Endpoint"] = "https://audit.example.invalid",
            ["Logbird:IngestKey"] = "lb_ingest_fictional",
            ["Logbird:BatchSize"] = "50",
            ["Logbird:FlushInterval"] = "00:00:02",
            ["Logbird:QueueFullBehavior"] = "DropNewest",
            ["Logbird:RedactKeys"] = "email, phone",
        }).Build();
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddLogbird(configuration.GetSection("Logbird"));
        using var provider = services.BuildServiceProvider();
        Assert.IsType<LogbirdClient>(provider.GetRequiredService<ILogbirdClient>());

        var missingKey = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Logbird:Endpoint"] = "https://audit.example.invalid" }).Build();
        Assert.Throws<ArgumentException>(() => new ServiceCollection().AddLogbird(missingKey.GetSection("Logbird")));
        var disabled = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["Logbird:Enabled"] = "false" }).Build();
        new ServiceCollection().AddLogbird(disabled.GetSection("Logbird"));
    }

    [Theory]
    [InlineData("Endpoint", "not a url lb_ingest_secret")]
    [InlineData("Enabled", "lb_ingest_secret")]
    [InlineData("BatchSize", "lb_ingest_secret")]
    [InlineData("FlushInterval", "lb_ingest_secret")]
    [InlineData("QueueFullBehavior", "lb_ingest_secret")]
    public void A_malformed_setting_fails_at_startup_naming_the_setting_but_never_its_value(string key, string value)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Logbird:Endpoint"] = "https://audit.example.invalid",
            ["Logbird:IngestKey"] = "lb_ingest_fictional",
            ["Logbird:" + key] = value,
        }).Build();
        var error = Assert.Throws<ArgumentException>(() => new ServiceCollection().AddLogbird(configuration.GetSection("Logbird")));
        Assert.Contains("'" + key + "'", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("secret", error.ToString(), StringComparison.Ordinal);
    }
}
