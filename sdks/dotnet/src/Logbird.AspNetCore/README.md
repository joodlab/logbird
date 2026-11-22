# Logbird for ASP.NET Core

Audit logging for ASP.NET Core applications. Build on [`Logbird`](https://www.nuget.org/packages/Logbird). Every
audit event recorded during a request gets its context filled in automatically: who (the signed-in user), which tenant,
the client IP and user agent, and request, trace and operation ids. Recording never slows down or fails the request.

```sh
dotnet add package Logbird.AspNetCore
```

```csharp
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
  id, `name` for the name, `tenant_id` for the tenant. Change the claim types, or supply `ResolveActor`,
  `ResolveTenant` and `ResolveImpersonator`, in `AddLogbird(..., configureRequests: r => ...)`. Anything an event sets
  itself wins.
- **Background jobs**: capture `audit.Carrier(parentEventId)` when you enqueue work, store it in the job payload
  (`AuditCarrierJsonContext` serializes it for trimmed and AOT apps), and record from the worker with
  `factory.ForJob(carrier, jobId, attempt)`. The worker's events keep the user as actor and the request's operation.
- **Shutdown**: a hosted service sends what is queued when the host stops, bounded by `ShutdownTimeout` (10 seconds
  by default; keep it below the host's `HostOptions.ShutdownTimeout`, 30 seconds by default). Hosted services stop in
  reverse order of registration, so call `AddLogbird` before registering hosted services that record events while they
  stop. An event recorded after Logbird has stopped is not sent; it is reported through `OnDrop` as `Shutdown`.
- **Configuration errors** fail at startup and name the setting, never its value. Call `AddLogbird` once; later calls
  do not change the registered client.
- **HTTP client**: Logbird sends through the named `HttpClient` "Logbird" from `IHttpClientFactory`, which never
  follows redirects.

See the [`Logbird` package README](https://github.com/joodlab/logbird/tree/master/sdks/dotnet) for options, failure
handling, redaction, reading the trail and verifying webhooks.
