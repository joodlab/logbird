# Logbird for ASP.NET Core

Audit logging for ASP.NET Core applications, built on [`Logbird`](https://www.nuget.org/packages/Logbird). Every audit
event recorded through `IAuditLog` during a request gets its context filled in: who (the signed-in user), which tenant,
the client IP and user agent, and request, trace and operation ids. Recording never throws into the request and never
waits for the network; it runs your configure callback, the resolvers and the event's serialization on the request
thread, so keep those fast.

```sh
dotnet add package Logbird.AspNetCore
```

```csharp
using Logbird.AspNetCore;

builder.Services.AddLogbird(builder.Configuration.GetSection("Logbird"));   // Endpoint, IngestKey, ...

var app = builder.Build();
app.UseLogbird();

app.MapPut("/invoices/{id}", (string id, IAuditLog audit) =>
{
    // ... save the change, then:
    audit.Record("invoice.updated", e => e.Target("invoice", id).Change("status", "draft", "sent"));
    return Results.NoContent();
});
```

```json
{ "Logbird": { "Endpoint": "https://audit.example.com", "IngestKey": "lb_ingest_...", "RedactKeys": "email,phone" } }
```

- **Actor and tenant** come from the user's claims when the event is recorded: `sub` or `NameIdentifier` for the actor
  id, `name` for the name, `tenant_id` for the tenant, read only from the request's authenticated primary identity.
  Change the claim types, or supply `ResolveActor`, `ResolveTenant` and `ResolveImpersonator`, in
  `AddLogbird(..., configureRequests: r => ...)`. An event recorded from inside a resolver is recorded without running
  the resolvers again.
- **What the event sets wins.** Only empty (`null`) fields are filled. To leave a field out, remove its flag:
  `audit.Record("report.exported", fill: AuditFill.All & ~AuditFill.Ip)`, or set `LogbirdRequestOptions.Fill` to never
  record it.
- **Configure callbacks** must complete synchronously; prepare anything asynchronous before calling `Record`. If the
  callback throws, the half-built event is not recorded and is reported through `OnDrop` as `Invalid`. A prepared
  `AuditEvent` passed to `Record` is copied and never changed.
- **Correlation headers**: `X-Logbird-Operation` and `X-Request-Id` (up to 256 characters; a longer value is ignored, never
  cut) and `traceparent`. A request re-executed by an exception handler keeps its first operation id.
- **Background jobs**: capture `audit.Carrier(parentEventId)` when you enqueue work, store it in the job payload
  (`AuditCarrierJsonContext` serializes it for trimmed and AOT apps), and record from the worker with
  `factory.ForJob(carrier, jobId, attempt)`. The worker's events keep the carrier's actor, tenant and operation exactly;
  without a carrier they get a system actor. A carrier holds the request's context; to carry one event's own actor or
  operation, adjust it with `carrier with { ... }`. Its `ToString()` prints no values, but a structured logger that
  serializes its properties would print the user and tenant ids, so do not log carriers.
- **Shutdown**: a hosted service sends what is queued when the host stops, within `ShutdownTimeout` (10 seconds by
  default) and the host's own `HostOptions.ShutdownTimeout` (30 seconds by default), whichever ends first. Events still
  unsent when the host's budget ends are reported through `OnDrop` as `Shutdown` and counted in `Stats` (the callback
  runs on a background thread, so a process that exits right away may not see it). Hosted services stop in reverse
  order of registration: call `AddLogbird` before registering hosted services that record events while they stop.
- **HTTP client**: Logbird sends through the named `HttpClient` "Logbird" from `IHttpClientFactory`. Its default handler
  never follows redirects, and the factory's request logging never prints header values (so the ingest key cannot
  appear in logs). If you replace the primary handler, set `AllowAutoRedirect = false` on yours.
- **Configuration errors** fail at startup (inside `AddLogbird`) and name the setting, never its value. Call
  `AddLogbird` once; later calls do not change the registered client.
- **Direct tracking**: events sent with `ILogbirdClient.Track` are not filled in; use `IAuditLog` for request context.

See the [`Logbird` package README](https://github.com/joodlab/logbird/tree/master/sdks/dotnet) for options, failure
handling, redaction, reading the trail and verifying webhooks.
