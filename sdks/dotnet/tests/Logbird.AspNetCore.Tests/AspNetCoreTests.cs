using System;
using System.Collections.Concurrent;
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
using Microsoft.Extensions.Logging;

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
            ClaimsPrincipal? user = null,
            Action<WebApplication>? pipeline = null,
            Action<WebApplicationBuilder>? services = null,
            FakeServer? fake = null)
        {
            var server = fake ?? new FakeServer();
            var builder = WebApplication.CreateBuilder();
            builder.WebHost.UseTestServer();
            services?.Invoke(builder);
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
            pipeline?.Invoke(app);
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
            requests: r =>
            {
                r.ServiceName = "billing-api";
                r.UseRequestIdHeader = true;
                r.UseOperationHeader = true;
            },
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
        var payload = carrier!.ToJson();
        var restored = AuditCarrier.FromJson(payload);
        Assert.Equal(carrier, AuditCarrier.FromJson(carrier.ToJsonUtf8Bytes()));
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
        Assert.IsType<HostedLogbirdClient>(provider.GetRequiredService<ILogbirdClient>());

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

    private static async Task<T[]> Eventually<T>(ConcurrentQueue<T> queue, int count)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (queue.Count < count && DateTime.UtcNow < deadline)
        {
            await Task.Delay(20);
        }

        return queue.ToArray();
    }

    private sealed class CapturedLogs : ILoggerProvider
    {
        public ConcurrentQueue<(string Category, string Message)> Entries { get; } = new();

        public Func<string, bool> Blocks { get; set; } = _ => false;

        /// <summary>Held closed while a blocking logger must stay blocked; the test opens it when done.</summary>
        public ManualResetEventSlim Release { get; } = new();

        public ILogger CreateLogger(string categoryName) => new Logger(this, categoryName);

        public void Dispose()
        {
        }

        private sealed class Logger(CapturedLogs owner, string category) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            {
                if (owner.Blocks(category))
                {
                    owner.Release.Wait();
                    throw new InvalidOperationException("fictional broken log sink");
                }

                var text = new System.Text.StringBuilder(formatter(state, exception));
                if (state is IEnumerable<KeyValuePair<string, object?>> pairs)
                {
                    foreach (var pair in pairs)
                    {
                        text.Append('|').Append(pair.Key).Append('=');
                        if (pair.Value is IEnumerable<string> values)
                        {
                            text.Append(string.Join(",", values));
                        }
                        else if (pair.Value is IEnumerable<KeyValuePair<string, IEnumerable<string>>> headers)
                        {
                            foreach (var header in headers)
                            {
                                text.Append(header.Key).Append(':').Append(string.Join(",", header.Value)).Append(';');
                            }
                        }
                        else
                        {
                            text.Append(pair.Value);
                        }
                    }
                }

                owner.Entries.Enqueue((category, text.ToString()));
            }
        }
    }

    private sealed class ThrowingConnection : Microsoft.AspNetCore.Http.Features.IHttpConnectionFeature
    {
        public string ConnectionId { get; set; } = "c1";

        public IPAddress? RemoteIpAddress { get => throw new InvalidOperationException("fictional"); set { } }

        public IPAddress? LocalIpAddress { get; set; }

        public int RemotePort { get; set; }

        public int LocalPort { get; set; }
    }

    [Fact]
    public async Task A1_the_ingest_key_never_reaches_http_client_logs()
    {
        var logs = new CapturedLogs();
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record("logged.request"))),
            services: b =>
            {
                b.Logging.ClearProviders();
                b.Logging.SetMinimumLevel(LogLevel.Trace);
                b.Logging.AddProvider(logs);
            });
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        await app.FlushedEventsAsync();
        Assert.NotEmpty(logs.Entries);
        Assert.DoesNotContain(logs.Entries, e => e.Category.StartsWith("System.Net.Http.HttpClient.Logbird", StringComparison.Ordinal));
        Assert.DoesNotContain(logs.Entries, e => e.Message.Contains("lb_ingest_fictional", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A2_the_whole_host_lifecycle_ends_within_the_hosts_budget_and_unsent_events_are_reported()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record("stuck.recorded"))),
            options: o =>
            {
                o.ShutdownTimeout = TimeSpan.FromSeconds(20);
                o.OnDrop = drops.Enqueue;
            },
            services: b => b.Services.Configure<HostOptions>(h => h.ShutdownTimeout = TimeSpan.FromMilliseconds(300)),
            fake: new FakeServer { Fallback = _ => new TaskCompletionSource<HttpResponseMessage>().Task });
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        var client = app.Client;

        // The host's 300 ms budget ends shutdown; a regression would wait out the client's 20-second ShutdownTimeout.
        await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
        {
            await app.Host.StopAsync();
            await app.Host.DisposeAsync();
        });

        // The report runs in the background once the host's budget ends.
        Assert.Equal(DropReason.Shutdown, Assert.Single(await Eventually(drops, 1)).Reason);
        Assert.Equal(1, client.Stats.Dropped);
    }

    [Fact]
    public async Task A3_default_actor_and_tenant_come_only_from_the_authenticated_primary_identity()
    {
        var principal = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, "alice")], "primary"));
        principal.AddIdentity(new ClaimsIdentity([new Claim("sub", "bob"), new Claim("tenant_id", "t_bob")], "secondary"));
        await using var app = await App.StartAsync(a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record("mixed.identities"))), user: principal);
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        var e = Assert.Single(await app.FlushedEventsAsync());
        Assert.Equal("alice", e.GetProperty("actor").GetProperty("id").GetString());
        Assert.False(e.TryGetProperty("tenant", out _));

        var anonymous = new ClaimsPrincipal(new ClaimsIdentity([new Claim("tenant_id", "t_spoofed")]));
        await using var second = await App.StartAsync(a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record("anonymous.request"))), user: anonymous);
        (await second.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        var anon = Assert.Single(await second.FlushedEventsAsync());
        Assert.False(anon.TryGetProperty("tenant", out _));
        Assert.False(anon.TryGetProperty("actor", out _));
    }

    [Fact]
    public async Task A4_a_prepared_event_that_cannot_be_copied_or_is_too_large_is_reported_without_copying_or_throwing()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var huge = new JsonArray();
        for (var i = 0; i < 300_000; i++)
        {
            huge.Add("x");
        }

        var large = new AuditEvent("large.prepared") { Metadata = { ["list"] = huge } };
        var duplicate = new AuditEvent("duplicate.prepared");
        JsonNode? parsed = null;
        try
        {
            parsed = JsonNode.Parse("{\"a\":1,\"a\":2}");
            duplicate.Metadata["dup"] = parsed;
        }
        catch (Exception)
        {
            // This runtime rejects duplicate names while parsing, so the copy path cannot meet one.
        }

        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) =>
            {
                audit.Record(large);
                audit.Record(duplicate);
                return Results.Ok();
            }),
            options: o => o.OnDrop = drops.Enqueue);
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        var reasons = (await Eventually(drops, parsed is null ? 1 : 2)).Select(d => d.Reason).ToArray();
        Assert.Contains(DropReason.TooLarge, reasons);
        Assert.Null(large.Id);
        Assert.Null(large.Actor);
    }

    [Fact]
    public async Task A5_a_blocked_or_throwing_logger_never_stalls_the_request()
    {
        var logs = new CapturedLogs { Blocks = category => category == "Logbird" };
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record("resolver.failed"))),
            requests: r => r.ResolveTenant = _ => throw new InvalidOperationException("fictional resolver bug"),
            user: User(("sub", "user_1")),
            services: b => b.Logging.AddProvider(logs));
        try
        {
            // The Logbird logger stays blocked while the request runs, so a request that waited on it would never finish.
            await Deadline.Within(TimeSpan.FromSeconds(30), async () => (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode());
        }
        finally
        {
            // FlushAsync waits for pending callbacks (documented), so the logger is released before flushing.
            logs.Release.Set();
        }

        var e = Assert.Single(app.Server.Requests.IsEmpty ? await app.FlushedEventsAsync() : app.Server.Requests.SelectMany(r => r.Events).ToArray());
        Assert.False(e.TryGetProperty("tenant", out _));
    }

    [Fact]
    public async Task A6_a_resolver_that_records_an_event_does_not_recurse()
    {
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record("page.viewed"))),
            requests: r => r.ResolveTenant = http =>
            {
                http.RequestServices.GetRequiredService<IAuditLog>().Record("tenant.lookup");
                return new AuditTenant("t_1");
            },
            user: User(("sub", "user_1")));
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        var events = await app.FlushedEventsAsync();
        Assert.Equal(2, events.Length);
        var viewed = events.Single(e => e.GetProperty("action").GetString() == "page.viewed");
        Assert.Equal("t_1", viewed.GetProperty("tenant").GetProperty("id").GetString());
        Assert.False(events.Single(e => e.GetProperty("action").GetString() == "tenant.lookup").TryGetProperty("tenant", out _));
    }

    [Fact]
    public async Task A7_an_unreadable_request_detail_is_left_out_and_the_event_is_still_recorded()
    {
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record("partial.context"))),
            pipeline: a => a.Use((context, next) =>
            {
                context.Features.Set<Microsoft.AspNetCore.Http.Features.IHttpConnectionFeature>(new ThrowingConnection());
                return next(context);
            }),
            requests: r => r.UseRequestIdHeader = true,
            user: User(("sub", "user_1")));
        using var request = new HttpRequestMessage(HttpMethod.Post, "/");
        request.Headers.Add("X-Request-Id", "req_partial");
        (await app.Http.SendAsync(request)).EnsureSuccessStatusCode();
        var e = Assert.Single(await app.FlushedEventsAsync());
        Assert.False(e.GetProperty("context").TryGetProperty("ip", out _));
        Assert.Equal("req_partial", e.GetProperty("context").GetProperty("requestId").GetString());
        Assert.Equal("user_1", e.GetProperty("actor").GetProperty("id").GetString());
    }

    [Fact]
    public async Task A8_a_throwing_configure_callback_drops_the_half_built_event_once_and_returns_its_id()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        string? returned = null;
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) =>
            {
                returned = audit.Record("half.built", e =>
                {
                    e.Id = "evt_stable_1";
                    e.Actor = AuditActor.User("explicit");
                    throw new InvalidOperationException("fictional callback bug");
                });
                return Results.Ok();
            }),
            options: o => o.OnDrop = drops.Enqueue);
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        Assert.Empty(await app.FlushedEventsAsync());
        Assert.Equal("evt_stable_1", returned);
        var drop = Assert.Single(await Eventually(drops, 1));
        Assert.Equal(DropReason.Invalid, drop.Reason);
        Assert.Equal("evt_stable_1", drop.Id);
        Assert.DoesNotContain("fictional", drop.Detail ?? string.Empty, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A9_a_shared_context_template_is_never_written_to()
    {
        var template = new AuditContext { ParentEventId = "evt_parent" };
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record("templated", e => e.Context = template))),
            requests: r => r.UseRequestIdHeader = true);
        foreach (var id in new[] { "req_a", "req_b" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/");
            request.Headers.Add("X-Request-Id", id);
            (await app.Http.SendAsync(request)).EnsureSuccessStatusCode();
        }

        var events = await app.FlushedEventsAsync();
        Assert.Null(template.RequestId);
        Assert.Null(template.Ip);
        Assert.Equal(new[] { "req_a", "req_b" }, events.Select(e => e.GetProperty("context").GetProperty("requestId").GetString()!).ToArray());
        Assert.All(events, e => Assert.Equal("evt_parent", e.GetProperty("context").GetProperty("parentEventId").GetString()));
    }

    [Fact]
    public async Task A10_fill_flags_leave_chosen_fields_out_per_event_and_globally()
    {
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) =>
            {
                audit.Record("no.ip.or.actor", fill: AuditFill.All & ~AuditFill.Ip & ~AuditFill.Actor);
                audit.Record("defaults");
                return Results.Ok();
            }),
            requests: r => r.Fill = AuditFill.All & ~AuditFill.UserAgent,
            user: User(("sub", "user_1")));
        using var request = new HttpRequestMessage(HttpMethod.Post, "/");
        request.Headers.UserAgent.ParseAdd("Fictional/1.0");
        (await app.Http.SendAsync(request)).EnsureSuccessStatusCode();
        var events = await app.FlushedEventsAsync();
        Assert.False(events[0].TryGetProperty("actor", out _));
        Assert.False(events[0].GetProperty("context").TryGetProperty("ip", out _));
        Assert.Equal("user_1", events[1].GetProperty("actor").GetProperty("id").GetString());
        Assert.Equal("203.0.113.9", events[1].GetProperty("context").GetProperty("ip").GetString());
        // A per-event value replaces the default entirely; the default (without the user agent) applies to the second.
        Assert.Equal("Fictional/1.0", events[0].GetProperty("context").GetProperty("userAgent").GetString());
        Assert.False(events[1].GetProperty("context").TryGetProperty("userAgent", out _));
    }

    [Fact]
    public async Task A11_record_returns_the_id_the_event_was_recorded_under()
    {
        var ids = new List<string>();
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) =>
            {
                ids.Add(audit.Record("blank.id", e => e.Id = "   "));
                ids.Add(audit.Record("replaced.id"));
                return Results.Ok();
            }),
            options: o => o.BeforeSend = e =>
            {
                if (e.Action == "replaced.id")
                {
                    e.Id = "evt_from_hook";
                }

                return e;
            });
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        var stored = (await app.FlushedEventsAsync()).Select(e => e.GetProperty("id").GetString()).ToArray();
        Assert.Equal(stored, ids.ToArray());
        Assert.Equal("evt_from_hook", ids[1]);
        Assert.False(string.IsNullOrWhiteSpace(ids[0]));
    }

    [Fact]
    public async Task A_requests_carrier_leaves_out_what_it_could_not_carry_unchanged_and_reports_it()
    {
        // Custom resolvers return a party without its id and parties holding a lone surrogate; a request's carrier is
        // still always writable: those parties are left out and reported, never changed.
        var errors = new System.Collections.Concurrent.ConcurrentQueue<Exception>();
        AuditCarrier? carrier = null;
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) =>
            {
                carrier = audit.Carrier("evt_" + (char)0xD800);
                return Results.Ok();
            }),
            requests: r =>
            {
                r.ResolveActor = _ => new AuditActor("user", null!);
                r.ResolveTenant = _ => new AuditTenant("acct_7") { Name = "Fictional " + (char)0xDC00 };
                r.ResolveImpersonator = _ => new AuditImpersonator("support_" + (char)0xD800);
            },
            options: o => o.OnError = errors.Enqueue);
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();

        Assert.NotNull(carrier);
        Assert.Null(carrier!.Actor);
        Assert.Null(carrier.Tenant);
        Assert.Null(carrier.Impersonator);
        Assert.Null(carrier.ParentEventId);
        Assert.Matches("^[0-9a-f]{8}-", carrier.OperationId);
        Assert.Equal(carrier, AuditCarrier.FromJson(carrier.ToJson()));

        Assert.True(await app.Client.FlushAsync());
        var reported = errors.Select(e => e.Message).Where(m => m.Contains("out of an audit carrier", StringComparison.Ordinal)).ToArray();
        Assert.Equal(4, reported.Length);
        Assert.All(reported, m => Assert.DoesNotContain("acct_7", m, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Correlation_headers_are_ignored_unless_turned_on()
    {
        // Any caller can send them: by default neither the request id nor the operation id comes from the request.
        await using var app = await App.StartAsync(a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record("client.headers"))));
        using var request = new HttpRequestMessage(HttpMethod.Post, "/");
        request.Headers.Add("X-Request-Id", "req_from_client");
        request.Headers.Add("X-Logbird-Operation", "op_from_client");
        (await app.Http.SendAsync(request)).EnsureSuccessStatusCode();
        var context = Assert.Single(await app.FlushedEventsAsync()).GetProperty("context");
        Assert.NotEqual("req_from_client", context.GetProperty("requestId").GetString());
        Assert.NotEqual("op_from_client", context.GetProperty("operationId").GetString());
        Assert.Matches("^[0-9a-f]{8}-", context.GetProperty("operationId").GetString());

        var defaults = new LogbirdRequestOptions();
        Assert.False(defaults.UseRequestIdHeader);
        Assert.False(defaults.UseOperationHeader);
    }

    [Fact]
    public async Task A12_an_overlength_correlation_header_is_ignored_never_cut()
    {
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record("long.headers"))),
            requests: r =>
            {
                r.UseRequestIdHeader = true;
                r.UseOperationHeader = true;
            });
        using var request = new HttpRequestMessage(HttpMethod.Post, "/");
        request.Headers.Add("X-Request-Id", new string('r', 257));
        request.Headers.Add("X-Logbird-Operation", new string('o', 257));
        (await app.Http.SendAsync(request)).EnsureSuccessStatusCode();
        var context = Assert.Single(await app.FlushedEventsAsync()).GetProperty("context");
        Assert.DoesNotContain("rrrr", context.GetProperty("requestId").GetString(), StringComparison.Ordinal);
        Assert.Matches("^[0-9a-f]{8}-", context.GetProperty("operationId").GetString());
    }

    [Fact]
    public async Task A13_job_context_is_decided_once_and_carriers_keep_absent_values_absent()
    {
        AuditCarrier? anonymous = null;
        await using var app = await App.StartAsync(a => a.MapPost("/", (IAuditLog audit) =>
        {
            anonymous = audit.Carrier();
            return Results.Ok();
        }));
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        var factory = app.Host.Services.GetRequiredService<IAuditLogFactory>();

        using var unrelated = new Activity("unrelated").SetIdFormat(ActivityIdFormat.W3C).Start();
        factory.ForJob(anonymous! with { TraceId = null }, worker: "w").Record("from.anonymous");
        unrelated.Stop();

        var scheduled = factory.ForJob(null, worker: "nightly");
        var chained = factory.ForJob(scheduled.Carrier("evt_1"), worker: "follow-up");
        chained.Record("chained");

        var events = await app.FlushedEventsAsync();
        var fromAnonymous = events.Single(e => e.GetProperty("action").GetString() == "from.anonymous");
        Assert.False(fromAnonymous.TryGetProperty("actor", out _));
        Assert.False(fromAnonymous.GetProperty("context").TryGetProperty("traceId", out _));
        var chainedEvent = events.Single(e => e.GetProperty("action").GetString() == "chained");
        Assert.Equal("system", chainedEvent.GetProperty("actor").GetProperty("type").GetString());
        Assert.Equal("nightly", chainedEvent.GetProperty("actor").GetProperty("id").GetString());
        Assert.Equal("evt_1", chainedEvent.GetProperty("context").GetProperty("parentEventId").GetString());
    }

    [Fact]
    public async Task A14_a_re_executed_request_and_events_recorded_before_the_middleware_share_one_operation()
    {
        await using var app = await App.StartAsync(
            a =>
            {
                a.MapPost("/fail", (IAuditLog audit) =>
                {
                    audit.Record("before.failure");
                    throw new InvalidOperationException("fictional endpoint failure");
                });
                a.Map("/error", (IAuditLog audit) => Results.Text(audit.Record("error.handled")));
            },
            pipeline: a =>
            {
                a.UseExceptionHandler("/error");
                a.Use((context, next) =>
                {
                    context.RequestServices.GetRequiredService<IAuditLog>().Record("early.event");
                    return next(context);
                });
            });
        await app.Http.PostAsync("/fail", null);
        var events = await app.FlushedEventsAsync();
        Assert.Contains(events, e => e.GetProperty("action").GetString() == "error.handled");
        Assert.Single(events.Select(e => e.GetProperty("context").GetProperty("operationId").GetString()).Distinct());
    }

    [Fact]
    public void A15_out_of_range_settings_and_request_callbacks_fail_inside_AddLogbird_without_values()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Logbird:Endpoint"] = "https://audit.example.invalid",
            ["Logbird:IngestKey"] = "lb_ingest_fictional",
            ["Logbird:BatchSize"] = "1001",
        }).Build();
        var error = Assert.ThrowsAny<ArgumentException>(() => new ServiceCollection().AddLogbird(configuration.GetSection("Logbird")));
        Assert.Contains("BatchSize", error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("1001", error.ToString(), StringComparison.Ordinal);

        Assert.Throws<InvalidOperationException>(() => new ServiceCollection().AddLogbird(
            o =>
            {
                o.Endpoint = new Uri("https://audit.example.invalid");
                o.IngestKey = "lb_ingest_fictional";
            },
            _ => throw new InvalidOperationException("fictional bad request options")));
    }

    [Fact]
    public async Task B3_a_traceparent_with_the_forbidden_version_is_not_used()
    {
        await using var app = await App.StartAsync(a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record("bad.trace"))));
        using var request = new HttpRequestMessage(HttpMethod.Post, "/");
        request.Headers.Add("traceparent", "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
        (await app.Http.SendAsync(request)).EnsureSuccessStatusCode();
        var context = Assert.Single(await app.FlushedEventsAsync()).GetProperty("context");
        Assert.False(context.TryGetProperty("traceId", out var trace) && trace.GetString() == "4bf92f3577b34da6a3ce929d0e0e4736");
    }

    [Fact]
    public async Task R2_host_shutdown_finishes_within_10_seconds_and_all_backlog_events_are_counted_as_dropped()
    {
        const int Count = 100_000;

        var fake = new FakeServer { Fallback = _ => new TaskCompletionSource<HttpResponseMessage>().Task };
        var app = await App.StartAsync(
            _ => { },
            options: o =>
            {
                o.MaxQueueSize = Count;
                o.ShutdownTimeout = TimeSpan.FromSeconds(20);
            },
            services: b => b.Services.Configure<HostOptions>(h => h.ShutdownTimeout = TimeSpan.FromMilliseconds(300)),
            fake: fake);
        var client = app.Client;
        for (var i = 0; i < Count; i++)
        {
            client.Track(new AuditEvent("backlog.recorded"));
        }

        // A full batch is sent as soon as the queue reaches the batch size; wait until that request is in flight.
        await Deadline.Within(TimeSpan.FromSeconds(30), async () =>
        {
            while (fake.Requests.IsEmpty)
            {
                await Task.Delay(10);
            }
        });

        // The host's 300 ms budget ends shutdown; a regression would wait out the 20-second ShutdownTimeout.
        await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
        {
            await app.Host.StopAsync();
            await app.Host.DisposeAsync();
        });

        await Deadline.Within(TimeSpan.FromSeconds(30), async () =>
        {
            while (client.Stats.Dropped < Count)
            {
                await Task.Delay(50);
            }
        });
        Assert.Equal(Count, client.Stats.Dropped);
        Assert.Equal(Count, client.Stats.Tracked);
    }

    [Fact]
    public async Task R5_no_retry_is_sent_after_the_host_deadline_reported_the_event_as_a_shutdown_drop()
    {
        var server = new FakeServer
        {
            Fallback = _ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
            {
                Headers = { RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(2)) },
            }),
        };
        var drops = new ConcurrentQueue<DroppedEvent>();
        var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record("retried.recorded"))),
            options: o =>
            {
                o.ShutdownTimeout = TimeSpan.FromSeconds(20);
                o.OnDrop = drops.Enqueue;
            },
            services: b => b.Services.Configure<HostOptions>(h => h.ShutdownTimeout = TimeSpan.FromMilliseconds(300)),
            fake: server);
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        _ = app.Client.FlushAsync();
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (server.Requests.IsEmpty && DateTime.UtcNow < deadline)
        {
            await Task.Delay(20);
        }

        // The sender is now in its two-second Retry-After backoff when the host's 300 ms budget ends.
        await app.Host.StopAsync();
        await app.Host.DisposeAsync();
        Assert.Equal(DropReason.Shutdown, Assert.Single(await Eventually(drops, 1)).Reason);
        await Task.Delay(TimeSpan.FromSeconds(3));
        Assert.Single(server.Requests);
    }

    [Fact]
    public async Task R6_an_OnDrop_callback_that_records_a_failing_event_cannot_feed_itself()
    {
        IAuditLogFactory? factory = null;
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record("first.failure", _ => throw new InvalidOperationException("fictional")))),
            options: o => o.OnDrop = d =>
            {
                drops.Enqueue(d);
                factory?.ForJob(null).Record("from.callback", _ => throw new InvalidOperationException("fictional"));
            });
        factory = app.Host.Services.GetRequiredService<IAuditLogFactory>();
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        await Eventually(drops, 1);
        await Task.Delay(500);
        Assert.Single(drops);
        Assert.Equal(1, app.Client.Stats.Dropped);
        Assert.Equal(1, app.Client.Stats.Filtered);
    }

    private sealed class FakeLogbirdClient : ILogbirdClient
    {
        public ConcurrentQueue<AuditEvent> Tracked { get; } = new();

        public LogbirdStats Stats => default;

        public void Track(AuditEvent auditEvent) => Tracked.Enqueue(auditEvent);

        public Task<bool> FlushAsync(CancellationToken cancellationToken = default) => Task.FromResult(true);
    }

    [Fact]
    public async Task R7_audit_logs_record_through_a_host_provided_client_and_return_the_id_even_when_disabled()
    {
        var fake = new FakeLogbirdClient();
        string? returned = null;
        await using (var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) =>
            {
                returned = audit.Record("faked.recorded");
                return Results.Ok();
            }),
            user: User(("sub", "user_1")),
            services: b => b.Services.AddSingleton<ILogbirdClient>(fake)))
        {
            (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        }

        var tracked = Assert.Single(fake.Tracked);
        Assert.Equal(returned, tracked.Id);
        Assert.Equal("user_1", tracked.Actor!.Id);

        string? disabledId = null;
        await using (var disabled = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) =>
            {
                disabledId = audit.Record("disabled.recorded");
                return Results.Ok();
            }),
            options: o => o.Enabled = false))
        {
            (await disabled.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        }

        Assert.False(string.IsNullOrEmpty(disabledId));
    }

    [Fact]
    public async Task R4_a_shallow_array_whose_separators_pass_the_limit_is_dropped_before_any_copy()
    {
        var drops = new ConcurrentQueue<DroppedEvent>();
        var zeroes = new JsonArray();
        // 600,000 zeroes with their separators measure 1.2 MB, over the 1 MiB pre-copy guard.
        for (var i = 0; i < 600_000; i++)
        {
            zeroes.Add(0);
        }

        var prepared = new AuditEvent("zeroes.prepared") { Metadata = { ["zeroes"] = zeroes } };
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record(prepared))),
            options: o => o.OnDrop = drops.Enqueue);
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        var drop = Assert.Single(await Eventually(drops, 1));
        Assert.Equal(DropReason.TooLarge, drop.Reason);

        // Refused by the pre-copy guard, not by the wire limit after a copy.
        Assert.Equal("The event's data exceeds 1 MiB before redaction.", drop.Detail);
        Assert.Null(prepared.Id);
    }

    [Fact]
    public async Task R02_both_recording_overloads_send_a_secret_that_redaction_shrinks()
    {
        // 270,000 characters before redaction, "[redacted]" after: the 256 KB limit is decided on what is sent, through
        // either overload, and the 1 MiB guard is the only check before the copy.
        var prepared = new AuditEvent("prepared.secret") { Metadata = { ["token"] = new string('s', 270_000) } };
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) =>
            {
                audit.Record(prepared);
                audit.Record("new.secret", e => e.Metadata["token"] = new string('s', 270_000));
                return Results.Ok();
            }),
            options: o => o.OnDrop = drops.Enqueue);
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        var events = await app.FlushedEventsAsync();

        Assert.Empty(drops);
        Assert.Equal(["new.secret", "prepared.secret"], events.Select(e => e.GetProperty("action").GetString()!).OrderBy(a => a, StringComparer.Ordinal).ToArray());
        Assert.All(events, e => Assert.Equal("[redacted]", e.GetProperty("metadata").GetProperty("token").GetString()));
        Assert.Null(prepared.Id);
    }

    [Fact]
    public async Task R02_a_prepared_event_over_the_guard_is_refused_with_the_clients_own_detail()
    {
        var prepared = new AuditEvent("prepared.huge") { Metadata = { ["token"] = new string('s', 1_100_000) } };
        var drops = new ConcurrentQueue<DroppedEvent>();
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) => Results.Text(audit.Record(prepared))),
            options: o => o.OnDrop = drops.Enqueue);
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();

        var drop = Assert.Single(await Eventually(drops, 1));
        Assert.Equal(DropReason.TooLarge, drop.Reason);
        Assert.Equal("The event's data exceeds 1 MiB before redaction.", drop.Detail);
        Assert.False(drop.MayBeStored);
        Assert.Null(prepared.Id);
    }

    [Fact]
    public async Task C1_with_a_host_provided_client_unrecordable_events_are_reported_and_the_callers_instance_is_never_handed_over()
    {
        var fake = new FakeLogbirdClient();
        var drops = new ConcurrentQueue<DroppedEvent>();
        var prepared = new AuditEvent("oversized.prepared") { Description = new string('d', 1_100_000) };
        var ids = new List<string>();
        await using (var app = await App.StartAsync(
            _ => { },
            options: o => o.OnDrop = drops.Enqueue,
            services: b => b.Services.AddSingleton<ILogbirdClient>(fake)))
        {
            var job = app.Host.Services.GetRequiredService<IAuditLogFactory>().ForJob(null, worker: "w");
            ids.Add(job.Record("half.built", e =>
            {
                e.Id = "evt_fixture";
                throw new InvalidOperationException("fictional");
            }));
            ids.Add(job.Record(prepared));
            await Eventually(drops, 2);
        }

        Assert.Empty(fake.Tracked);
        Assert.Equal("evt_fixture", ids[0]);
        Assert.False(string.IsNullOrEmpty(ids[1]));
        Assert.Null(prepared.Id);
        Assert.Null(prepared.Executor);
        Assert.Equal([DropReason.Invalid, DropReason.TooLarge], drops.Select(d => d.Reason).ToArray());
        Assert.Equal(new[] { "evt_fixture", ids[1] }, drops.Select(d => d.Id!).ToArray());
    }

    [Fact]
    public async Task C1_an_oversized_prepared_event_returns_an_id_even_when_capture_is_disabled()
    {
        string? id = null;
        await using var app = await App.StartAsync(
            a => a.MapPost("/", (IAuditLog audit) =>
            {
                id = audit.Record(new AuditEvent("oversized") { Description = new string('d', 1_100_000) });
                return Results.Ok();
            }),
            options: o => o.Enabled = false);
        (await app.Http.PostAsync("/", null)).EnsureSuccessStatusCode();
        Assert.False(string.IsNullOrEmpty(id));
    }
}
