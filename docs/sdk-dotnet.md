# Logbird for .NET

Logbird records who did what, to which record, and when: an audit trail you can search, show to customers and export.
This guide takes a C# backend from nothing to its first stored audit event and explains what happens when things go
wrong. It assumes ASP.NET Core on .NET 8 or newer; a plain client for other hosts (including .NET Framework, tested on
4.8) is at the end.

Two packages:

| Package | For |
| --- | --- |
| `Logbird.AspNetCore` | ASP.NET Core apps: `AddLogbird()`, request context on every event, background jobs, flush on shutdown |
| `Logbird` | The client itself: any .NET host, reading the trail back, verifying webhooks |

## 1. Install

> The packages are not on nuget.org yet. Until they are, build against the source: clone this repository and reference
> `sdks/dotnet/src/Logbird.AspNetCore/Logbird.AspNetCore.csproj` from your project, as
> [`examples/aspnetcore`](../examples/aspnetcore) does. Once published, it is one command:

```sh
dotnet add package Logbird.AspNetCore
```

## 2. Configure

In Logbird, create a project and an **ingest key** for it. Add the endpoint to `appsettings.json`:

```json
{
  "Logbird": { "Endpoint": "https://audit.example.com" }
}
```

Keep the key out of source control. Set it with user secrets in development and an environment variable in production:

```sh
dotnet user-secrets set Logbird:IngestKey <your ingest key>   # development
export Logbird__IngestKey=<your ingest key>                     # production
```

`Endpoint` is your Logbird origin (without `/v1/events`). It must use `https`; plain `http` is accepted only for a
loopback address such as `localhost` or `127.0.0.1`, or for any host if you set `AllowInsecureHttp = true` (only for a
network you trust).

## 3. Record your first event

Register Logbird and its middleware in `Program.cs`:

```csharp
using Logbird;
using Logbird.AspNetCore;

builder.Services.AddLogbird(builder.Configuration.GetSection("Logbird"));

var app = builder.Build();
app.UseAuthentication();
app.UseLogbird();
```

Then inject `IAuditLog` wherever a change is committed. In a controller:

```csharp
using Logbird;
using Logbird.AspNetCore;

[Authorize]
public class InvoicesController(InvoiceService invoices, IAuditLog audit) : ControllerBase
{
    [HttpPut("invoices/{id}/status")]
    public async Task<IActionResult> SetStatus(string id, [FromBody] string status)
    {
        var (before, after) = await invoices.SetStatusAsync(id, status);
        audit.Record("invoice.status_changed", e => e.Target("invoice", id).Change("status", before, after));
        return NoContent();
    }
}
```

That is the whole integration. The event Logbird stores looks like this (ids shortened):

```json
{
  "action": "invoice.status_changed",
  "actor": { "type": "user", "id": "user_42", "name": "Ana Fictional" },
  "tenant": { "id": "acct_7" },
  "executor": { "type": "api", "id": "billing-api" },
  "targets": [{ "type": "invoice", "id": "inv_1001" }],
  "changes": [{ "field": "status", "before": "draft", "after": "sent" }],
  "context": { "operationId": "0192…", "requestId": "0HN…", "traceId": "4bf9…", "ip": "203.0.113.9", "userAgent": "…" }
}
```

Name actions `noun.verb_in_past_tense` (`invoice.status_changed`, `user.signed_in`), record after the change is saved,
and use your own stable ids for targets.

## 4. How the actor and tenant are found

You did not pass the user or the tenant. `IAuditLog` fills every field the event leaves empty, at the moment you call
`Record`:

- **Actor**: from the signed-in user's claims, `sub` (or `NameIdentifier`) for the id and `name` for the name. Email
  is added only if you opt in. Only the request's authenticated primary identity is read.
- **Tenant**: from the `tenant_id` claim.
- **Executor**: `api:<your application name>` (set `ServiceName` to choose the name).
- **Context**: operation, request and trace ids, client IP and user agent, from the request. The `X-Request-Id` and
  `X-Logbird-Operation` headers are used only when you turn on `UseRequestIdHeader` and `UseOperationHeader` (off by
  default): any caller can send them, so enable them only behind an ingress that sets or strips them.

Your claims are different? Change the claim types or supply your own resolvers. These options go into your one
`AddLogbird` call (it is registered once; a second call changes nothing):

```csharp
builder.Services.AddLogbird(builder.Configuration.GetSection("Logbird"), configureRequests: r =>
{
    r.ServiceName = "billing-api";
    r.ActorIdClaimTypes.Insert(0, "uid");

    // Read the tenant your own authorization already checked, never one the caller chose (such as a raw route value).
    r.ResolveTenant = http => http.Items["AuthorizedTenantId"] is string t ? new AuditTenant(t) : null;
});
```

Anything the event sets itself wins. At sign-in, for example, the user is not on `HttpContext.User` until the next
request, so name them on the event:

```csharp
audit.Record("user.signed_in", e =>
{
    e.Actor = AuditActor.User(user.Id, user.Name);
    e.Tenant = new AuditTenant(user.TenantId);
});
```

To leave a field out (for example the IP address), remove its flag: `audit.Record("report.exported", fill: AuditFill.All & ~AuditFill.Ip)`,
or set `LogbirdRequestOptions.Fill` for every event.

**Background jobs** continue the request's operation. Capture a carrier when you enqueue the work and record from the
worker with it; the job's events keep the user as actor and link to the request's event:

```csharp
var requested = audit.Record("invoice.send_requested", e => e.Target("invoice", id));
jobs.Enqueue(new SendInvoice(id, audit.Carrier(parentEventId: requested)));   // the carrier serializes to JSON

// In the worker (inject IAuditLogFactory):
var jobAudit = auditFactory.ForJob(job.Carrier, jobId, attempt);
jobAudit.Record("invoice.emailed", e => e.Target("invoice", job.InvoiceId));
```

## 5. When Logbird is down

Audit logging never takes your application down with it:

- **`Record` never throws and never waits for the network.** It queues the event in memory and returns. A background
  loop sends batches every second.
- **Failures are retried** with backoff (network errors, 429, 5xx). Each retried event keeps its exact bytes and id, so
  the server stores it once (it deduplicates by id while it retains the event).
- **The queue is bounded** (`MaxQueueSize`, 10,000 events by default, counting the events waiting to be sent; the batch
  being sent comes on top, and `Stats.QueueLength` counts both). If Logbird stays unreachable long enough to fill
  it, events are dropped by `QueueFullBehavior`: by default (`DropOldest`) the oldest queued ones. Each drop is
  counted, and reported to `OnDrop` on a best-effort basis (below).
- **Every event the running client gives up on is counted**, once, with a reason (`QueueFull`, `HttpError`,
  `Rejected`, `Shutdown`, …): rejections by the server on the `logbird.events.rejected` counter, everything else on
  `logbird.events.dropped`. These are process totals: they keep every client's counts after it is disposed (only the
  queue-length gauge leaves with the client). `OnDrop` and the log are told about them on the background thread, and
  both reports are best effort: disposal waits at most five seconds for pending callbacks, and when the callback
  backlog is full (next point) the notifications are skipped, so a slow callback (or a process that exits right after
  shutdown) can miss them. Events lost in a crash are not reported at all (see the outbox below).
- **`OnDrop` is told about each one** on a background thread; if your callback falls far behind (more than
  `MaxQueueSize` notifications, and at least 1,000), further notifications are skipped and counted on
  `logbird.notifications.lost`, so keep it fast.
- **Some of those events are unconfirmed rather than lost**: when a request times out, a response's acknowledgement is
  lost on the way back, or shutdown ends while a batch is in flight, the server may already have stored the event.
  `DroppedEvent.MayBeStored` says so for each one, whatever its reason (a `QueueFull` event sent before it was evicted
  can be one): decide by it, not by the reason.
- **On shutdown** the host sends what is queued, within `ShutdownTimeout` (10 seconds) and the host's own shutdown
  budget.

Wire the reports into your logs or alerting, in the same `AddLogbird` call as the request options above:

```csharp
builder.Services.AddLogbird(
    builder.Configuration.GetSection("Logbird"),
    configure: o => o.OnDrop = dropped =>
        Console.Error.WriteLine($"audit event dropped: {dropped.Reason} {dropped.Code} (may be stored: {dropped.MayBeStored})"),
    configureRequests: r => r.ServiceName = "billing-api");
```

The queue lives in memory, so a crash loses what is queued. For events that must survive a crash, write them to your
own database in the same transaction as the change (an outbox), with their id, their `OccurredAt` and their content,
and send them from there exactly as stored on every attempt. A resend is then an exact retry while the server retains
the original; an event rebuilt with a new timestamp would conflict with the copy the server already has. If you use a
`BeforeSend` hook, make sure it changes an outbox event the same way on every attempt (or leaves it alone) and keeps its
id, so each resend carries the same id and content.

The example logs the reason and code, not the event's id or action: those can name a customer or a record, so log
them only where your policy allows (keep them in your outbox instead).

`Track` only queues an event, and a successful `FlushAsync` means each event was stored *or* given up on, so neither
proves an event was stored. Keep each outbox row until you have confirmed its event: find it by id with
`LogbirdReadClient.GetEventAsync(id)` and check that its stored payload (`EventDetail.Payload`, not null) matches the
event as sent, that is the row after your `BeforeSend` and redaction. The id alone does not confirm it, because after a
`duplicate_id_conflict` a different event owns that id; and a read through a masked viewer token or scope cannot confirm
it either, because it returns no payload. Resend the row, exactly as stored,
until it is confirmed. Resending an event the server
still holds is always safe (an exact retry), but do not resend rows older than the project's retention period: once
retention has deleted an event, a resend would store it again. Decide yourself what happens to a row that is never
confirmed (for example alert and keep it); Logbird cannot make that choice for you.

## 6. Check that it worked

- **In the Logbird console**, open the project's Explorer. Filter by `action:invoice.status_changed`, or by
  `operation:"<operation id>"` to see a request and the jobs it started together.
- **From code**, read the trail back with a read key (server side only):

  ```csharp
  using Logbird;

  using var reader = new LogbirdReadClient(new LogbirdReadOptions
  {
      Endpoint = new Uri("https://audit.example.com"),
      ReadKey = builder.Configuration["Logbird:ReadKey"],
  });
  var page = await reader.SearchAsync(EventSearch.ForTrail(targetId: "inv_1001"));
  foreach (var e in page.Events) Console.WriteLine($"{e.Timestamp:u} {e.Action} by {e.Actor?.Id}");
  ```

- **In your process**, `ILogbirdClient.Stats` shows how many events were tracked, delivered, rejected and dropped, and
  the same numbers are on the `Logbird` meter for OpenTelemetry or `dotnet-counters`.

During development, a quick end-to-end check is the example app: run [`examples/aspnetcore`](../examples/aspnetcore)
against your Logbird and follow its README.

## Without ASP.NET Core

For a console app, a worker without the generic host, or .NET Framework, create one client for the process and
dispose it on shutdown. Disposing sends what is queued, within `ShutdownTimeout`:

```csharp
using System;
using Logbird;

public static class Program
{
    public static void Main()
    {
        using (var logbird = new LogbirdClient(new LogbirdOptions
        {
            Endpoint = new Uri("https://audit.example.com"),
            IngestKey = Environment.GetEnvironmentVariable("LOGBIRD_INGEST_KEY"),
        }))
        {
            logbird.Track(new AuditEvent("invoice.status_changed")
            {
                Actor = AuditActor.User("user_42"),
                Tenant = new AuditTenant("acct_7"),
            }.Target("invoice", "inv_1001").Change("status", "draft", "sent"));
        }
    }
}
```

This compiles with C# 7.3, the default for .NET Framework projects, and every newer version. A .NET Framework project
also needs a reference to `System.Net.Http` (`<Reference Include="System.Net.Http" />` in the project file, or Add
Reference, Assemblies), because the client's constructors accept an `HttpClient`. In a long-running
process, create the client once at startup instead and dispose it when the process stops. On .NET 8 you can write
`await using var logbird = ...`. To send what is queued without disposing, call `logbird.Flush(TimeSpan.FromSeconds(5))`.

## Going further

- [`Logbird` package README](../sdks/dotnet/README.md): every option, the exact failure contract, redaction (values under
  keys and change fields that match the secret pattern, such as `password` or `token`, are replaced before sending;
  free text such as `Description` is not scanned, so never put secrets there; identifiers are never changed), reading
  the trail, verifying webhooks, and the guarantees about the wire format.
- [`Logbird.AspNetCore` README](../sdks/dotnet/src/Logbird.AspNetCore/README.md): request context, fill rules, jobs,
  shutdown ordering.
- [Integrating an existing backend](integrating-a-backend.md): what to record and how to model events, whatever the
  language.
