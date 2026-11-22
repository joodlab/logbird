# Logbird for .NET

Audit logging for C# backends. Record who did what to which record, then search, prove and export that history
in [Logbird](https://github.com/joodlab/logbird). The client is built to sit inside a production application:

- **It never slows your requests.** `Track` serializes the event and queues it in memory. A background loop sends
  batches; no network call happens on your thread.
- **It never breaks your application.** Nothing Logbird does throws into your code. Problems go to a callback, your
  `ILogger` and the `Logbird` meter.
- **It does not lose events silently.** Every event that will not be stored (queue full, rejected by the server,
  unsent at shutdown) is counted and passed to `OnDrop` together with its JSON, so you can save it and send it again.
- **Retries never duplicate.** Each event gets a stable id (UUIDv7) when you track it. A retry resends identical
  bytes, and Logbird stores one event per id.

Targets .NET 8 and later (trimming and Native AOT compatible) and .NET Standard 2.0, so .NET Framework 4.6.2+
applications can use it too. Dependencies: `System.Text.Json` and `Microsoft.Extensions.Logging.Abstractions`.

## Install

```sh
dotnet add package Logbird
```

You need a Logbird project and an **ingest key** (`lb_ingest_…`). Keep the key on the server.

## Record events

Create one client for your application. It is thread-safe. Dispose it on shutdown so queued events are sent.

```csharp
using Logbird;

await using var audit = new LogbirdClient(new LogbirdOptions
{
    Endpoint = new Uri("https://audit.example.com"),   // your Logbird origin, without /v1/events
    IngestKey = Environment.GetEnvironmentVariable("LOGBIRD_INGEST_KEY"),
    Environment = "production",
});

// After the change is committed:
audit.Track(new AuditEvent("invoice.updated")
{
    Actor = AuditActor.User(user.Id, name: user.DisplayName),
    Tenant = new AuditTenant(account.Id) { Name = account.Name },
    Targets = { new AuditTarget("invoice", invoice.Id) { Name = invoice.Number } },
    Changes = { new AuditChange("status", "draft", "sent") },
    Context = { OperationId = operationId, RequestId = requestId },
    Metadata = { ["plan"] = "pro" },
});
```

The same event can be written fluently:

```csharp
audit.Track(new AuditEvent("invoice.updated") { Actor = AuditActor.User(user.Id) }
    .Target("invoice", invoice.Id, invoice.Number)
    .Change("status", "draft", "sent"));
```

For ASP.NET Core, a `Logbird.AspNetCore` package is on the way. It registers the client, fills the actor, tenant,
IP, user agent and request and trace ids from each request, and flushes when the host stops.

### What goes in an event

| Member | Meaning | Example |
| --- | --- | --- |
| `Action` (required) | A stable name for what happened, `<entity>.<verb>` | `invoice.updated` |
| `Actor` | Who caused it, from authenticated state | `AuditActor.User("user_42")`, `AuditActor.System("nightly-billing")` |
| `Executor` | What performed it: the API, a worker, a job attempt | `AuditExecutor.Worker("billing-worker", jobId, attempt)` |
| `Tenant` | The business scope, resolved after authorization | `new AuditTenant("acct_7")` |
| `Targets` | The records it affected | `new AuditTarget("invoice", "inv_1001")` |
| `Changes` | Before and after values you may store | `new AuditChange("status", "draft", "sent")` |
| `Context` | `OperationId`, `ParentEventId`, `RequestId`, `TraceId`, `Ip`, `UserAgent` | |
| `Outcome`, `Severity` | `AuditOutcome.Success`, `AuditSeverity.Warning`, ... | |
| `Description`, `Source`, `OccurredAt`, `Environment` | | |
| `Metadata` | Any extra JSON; searchable as `attr.metadata.<key>` | `["plan"] = "pro"` |

Change values and metadata are JSON (`JsonNode`). Strings, numbers and booleans convert implicitly. A `long`,
`ulong` or `decimal` is sent with every digit. `AuditChange.Set` records a new field, `AuditChange.Removed` a deleted
one, and `AuditChange.Secret("password")` records that a secret changed without storing it.

A worker doing work a user requested keeps the user as the `Actor` and sets itself as the `Executor`. Carry the
`OperationId` (and the request event's id as `ParentEventId`) into background jobs so Logbird can group the request
with everything it caused.

## Failures, drops and shutdown

```csharp
var options = new LogbirdOptions
{
    // ...
    MaxQueueSize = 10_000,                        // events kept in memory while Logbird is unreachable
    QueueFullBehavior = QueueFullBehavior.DropOldest,
    OnError = error => logger.LogWarning("Audit delivery problem: {Message}", error.Message),
    OnDrop = dropped => outbox.Save(dropped.Id, dropped.JsonText),   // optional: keep it for replay
};
```

- Network errors, 429 and 5xx are retried with exponential backoff and `Retry-After`, up to `MaxRetries` (5) and
  five minutes per batch. If a batch still fails, it goes back to the front of the queue and is tried again later.
- When the server rejects single events in a batch (for example an invalid id), only those events are dropped
  (`DropReason.Rejected`, with the server's reason in `Detail`). The rest of the batch is stored.
- A 4xx other than 429 (for example a revoked key) drops the batch (`DropReason.HttpError`) and reports it.
- `client.Stats` gives counts of tracked, delivered, rejected, dropped and filtered events. The `Logbird` meter
  publishes the same counts for OpenTelemetry (`logbird.events.*`, `logbird.queue.length`).
- `await client.FlushAsync()` waits until everything queued so far is settled and returns `false` if delivery failed.
  It never throws. Without a generic host (console apps, .NET Framework services), call
  `client.Flush(TimeSpan.FromSeconds(10))` or `Dispose()` before the process exits. Both run on the thread pool and
  cannot deadlock on a UI or ASP.NET synchronization context.
- Disposing sends what is queued, waiting at most `ShutdownTimeout` (10 seconds). Events still unsent afterwards,
  including a batch whose request has not returned, go to `OnDrop` once each with `DropReason.Shutdown`. A late
  response is then ignored. If that event did reach the server, replaying it from `OnDrop` is still safe, because
  its id is the same.

The queue lives in memory, so a crash loses events that were not yet sent. If an event must survive a crash, save
it in your database in the same transaction as the change (an outbox), keep its id (`LogbirdClient.NewEventId()`),
and track it from there. Sending it twice is safe.

Logbird's own HTTP calls, log messages and callbacks never record events. If your host audits all outgoing HTTP
or forwards logs to Logbird, there is no feedback loop.

## Redaction

Secrets are redacted by default. A key matching passwords, secrets, tokens, one-time codes, API keys,
authorization, cookies, credentials or private keys keeps its name, and its value becomes `[redacted]`. This applies
at any depth (actor, targets, context, metadata) and to the before and after values of matching change fields.
The default does not cover personal data, so add your own keys:

```csharp
options.Redaction.AddKeys("email", "phone", "iban");
```

Redaction behaves like the TypeScript SDK's `redact()`. Set `Redaction.Enabled = false` to turn it off, or replace
`Redaction.Keys` with your own pattern. `BeforeSend` runs before redaction on a copy of each event; return `null`
to skip an event.

## Read the audit trail

Use a **read key** (`lb_read_…`) on the server only. Reading throws `LogbirdApiException` on failure, because the
caller needs the data.

```csharp
using var reader = new LogbirdReadClient(new LogbirdReadOptions
{
    Endpoint = new Uri("https://audit.example.com"),
    ReadKey = Environment.GetEnvironmentVariable("LOGBIRD_READ_KEY"),
});

var page = await reader.SearchAsync(new EventSearch { Query = "action:invoice.* actor:user_42", Limit = 50 });
await foreach (var e in reader.SearchAllAsync(EventSearch.ForTrail(targetId: invoice.Id, targetType: "invoice")))
{
    Console.WriteLine($"{e.Timestamp:u} {e.Actor?.Name} {e.Action}");
}

EventDetail? detail = await reader.GetAsync(eventId);   // null when it does not exist
```

A search filter is not authorization. When you show history to your own customers, check that the signed-in user
may see the tenant or record first, on every request including next-page requests.

## Verify webhooks

Logbird signs webhook deliveries with [Standard Webhooks](https://www.standardwebhooks.com/). Verify the raw body
before parsing it:

```csharp
var verifier = new WebhookVerifier(configuration["Logbird:WebhookSecret"]!);   // whsec_...

try
{
    JsonElement delivery = verifier.Verify(rawBody, name => request.Headers[name]);
}
catch (WebhookVerificationException e)
{
    return Results.BadRequest(e.Reason.ToString());
}
```

`WebhookVerifier` accepts several secrets during a rotation, checks the timestamp within five minutes, and compares
signatures in constant time. It passes the same test vectors as the TypeScript SDK. A malformed secret throws
`ArgumentException` when the verifier is created, so a configuration error shows up at startup and not as a 400.

## Compatibility

| Runtime | Build used |
| --- | --- |
| .NET 8, 9, 10 and later | `net8.0` (trimming and Native AOT compatible) |
| .NET Framework 4.6.2+ (tested on 4.8) | `netstandard2.0` |

The wire format is byte-for-byte identical to the TypeScript SDK's. A test serializes the same event in both SDKs
and compares the bytes.
