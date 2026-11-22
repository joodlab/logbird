# Logbird for .NET

Audit logging for C# backends. Record who did what to which record, then search and export that history
in [Logbird](https://github.com/joodlab/logbird). The client is built to sit inside a production application:

- **It never slows your requests.** `Track` serializes the event and queues it in memory. A background loop sends
  batches; no network call happens on your thread.
- **It never breaks your application.** Nothing Logbird does throws into your code. Problems go to a callback, your
  `ILogger` and the `Logbird` meter.
- **It does not lose events silently.** Every event that will not be stored (queue full, rejected by the server,
  unsent at shutdown) is counted, and passed to `OnDrop` together with its JSON so you can save it and send it again.
  The callbacks run on a bounded background queue: if they fall more than `MaxQueueSize` notifications behind,
  further ones are skipped and counted, while the counters keep every event.
- **Retries never duplicate.** Each event gets a stable id (UUIDv7) when you track it. A retry resends identical
  bytes, and Logbird stores one event per id.

Targets .NET 8 and later (trimming and Native AOT compatible) and .NET Standard 2.0, so .NET Framework 4.6.2+
applications can use it too. Dependencies: `System.Text.Json` and `Microsoft.Extensions.Logging.Abstractions`. A .NET
Framework project also needs a reference to `System.Net.Http` (`<Reference Include="System.Net.Http" />`).

New to Logbird? [Logbird for .NET](https://github.com/joodlab/logbird/blob/master/docs/sdk-dotnet.md) walks through a
first event in an ASP.NET Core app, and [`examples/aspnetcore`](https://github.com/joodlab/logbird/tree/master/examples/aspnetcore)
is a complete app to copy from.

## Install

```sh
dotnet add package Logbird
```

You need a Logbird project and an **ingest key** (`lb_ingest_…`). Keep the key on the server. The endpoint must use
`https`; plain `http` is accepted for `localhost` (local development) or when you set `AllowInsecureHttp = true` for a
private network you trust.

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

### Identifiers

Actor, impersonator, executor and tenant ids and each target's type and id are **sent exactly as you give them**:
never trimmed, truncated or converted. The text is the identity, so `"user_42"` and `" user_42 "` are different
actors. Before sending, the client applies the server's identifier rule (servers before that rule ships may still trim
identifiers when they store them; the client never does):

- An identifier that cannot be stored as sent drops the event with `DropReason.InvalidEntityId` (reason
  `invalid_entity_id`): longer than 256 UTF-16 code units (64 for a target type), containing a lone surrogate, or more
  than 256 targets on one event.
- Surrounding whitespace is kept and reported as a `LogbirdEventWarning` through `OnError` and the logger.
- An empty string means the field is absent.

Identifiers are strings in this SDK. For a numeric id, pass an integer's invariant text, for example
`userId.ToString(CultureInfo.InvariantCulture)` for a `long` gives `"42"`. Avoid formatting a `decimal` (`42.0m` keeps its
scale and becomes `"42.0"`). The server stores a numeric identifier as the plain decimal text of its value, so the string
`"42"` and the number `42` are the same identity, while `"42.0"` is a different one. For a `Guid`, pick one format
(`guid.ToString()` gives lowercase `d0c4…`) and keep it, because a different format is a different identity.

The server can also attach warnings to stored events (for example an `occurredAt` outside the accepted window, stored
at receive time); they arrive the same way, as `LogbirdEventWarning`, and are counted in `Stats.Warnings`.

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
  five minutes per batch. Each request is limited by `RequestTimeout` (30 seconds), even if a custom HTTP handler
  ignores cancellation. If a batch still fails, it goes back to the front of the queue and is tried again later.
- When the server rejects single events in a batch (for example an invalid id), only those events are dropped
  (`DropReason.Rejected`, with the server's reason in `Detail`). The rest of the batch is stored.
- A success response counts only for events it acknowledges (accepted by id, or rejected by index). If something in
  front of Logbird answers 2xx without acknowledging events, they are retried with the same bytes and, once the retry
  budget is spent, dropped with `DropReason.Unacknowledged`; they are never counted as delivered.
- A 4xx other than 429 (for example a revoked key) drops the batch (`DropReason.HttpError`) and reports it. So does
  a redirect: the client never follows one, because that would send audit data to another address. If you pass your
  own `HttpClient`, configure its handler with `AllowAutoRedirect = false` as well.
- `OnDrop`, `OnError` and log messages run in order on a background thread, never on the thread that called `Track`
  and never on the shutdown path, so a slow callback cannot slow your requests. If the callbacks fall more than
  `MaxQueueSize` (at least 1,000) notifications behind, further notifications are skipped and counted on the
  `logbird.notifications.lost` meter; the counters below still record every event. `FlushAsync` returns after the
  callbacks for what it settled have run.
- `client.Stats` gives counts of tracked, delivered, rejected, dropped, filtered and warned events. The `Logbird` meter
  publishes the same counts for OpenTelemetry (`logbird.events.*`, `logbird.batches.failed`, `logbird.queue.length`,
  `logbird.notifications.lost`). The instruments are observable: a listener reads the counters when it collects, on its
  own thread, so a slow or failing exporter never runs on your request path.
- `await client.FlushAsync()` waits until everything queued so far is settled and returns `false` if delivery failed.
  It never throws. Without a generic host (console apps, .NET Framework services), call
  `client.Flush(TimeSpan.FromSeconds(10))` or `Dispose()` before the process exits. Both run on the thread pool and
  cannot deadlock on a UI or ASP.NET synchronization context.
- Disposing sends what is queued, waiting at most `ShutdownTimeout` (10 seconds). Events still unsent afterwards,
  including a batch whose request has not returned, go to `OnDrop` once each with `DropReason.Shutdown`. A late
  response is then ignored. If that event did reach the server, replaying it from `OnDrop` is still safe, because
  its id is the same.

The queue lives in memory, so a crash loses events that were not yet sent. If an event must survive a crash, save
it in your database in the same transaction as the change (an outbox) with its `Id` (`LogbirdClient.NewEventId()`)
**and** its `OccurredAt`, and track it from there with both set. Sending it twice is then safe; a resend with a new
timestamp would be a different event and is rejected as `duplicate_id_conflict`.

Logbird's own HTTP calls, log messages and callbacks never record events. If your host audits all outgoing HTTP
or forwards logs to Logbird, there is no feedback loop.

## The contract with your code

Logbird runs code you supply: a `BeforeSend` hook, redaction patterns, `OnDrop`/`OnError`, your `ILogger`, metric
listeners and, if you pass one, your `HttpClient`'s handlers. This is where each runs, what Logbird does when it fails,
and what bounds apply. **Your code must not block, and should be fast.** The bounds below are what Logbird guarantees
even when it does not.

| Your code | Runs on | If it throws | If it blocks or runs long |
| --- | --- | --- | --- |
| `BeforeSend`, `Redaction.Keys`/`ChangeFields` patterns | The thread calling `Track`, synchronously | The event is dropped (`DropReason.Invalid`) and reported | `Track` waits for it. No bound: keep hooks fast, and give custom `Regex` patterns a match timeout |
| `OnDrop`, `OnError`, your `ILogger` | One Logbird background thread, in order | Swallowed and counted (`logbird.callbacks.failed`) | Later notifications queue up to `MaxQueueSize` (at least 1,000), then are skipped and counted (`logbird.notifications.lost`). `Track`, delivery and shutdown are never held |
| Metric listeners | The listener's own thread, when it collects (all instruments are observable) | Not Logbird's concern; publishing a new instrument that fails disables that instrument | Never on Logbird's paths |
| `HttpClient` handlers you supply | The thread pool | Treated as a network error and retried | Each request is limited by `RequestTimeout` plus up to 2 seconds; at most 4 abandoned requests are kept, further sends fail fast until they finish |

What the client's own methods guarantee:

- **`Track`** never throws and never waits for the network. It serializes the event on your thread (tens of
  microseconds for a typical event) and returns. Your own `BeforeSend` and redaction patterns are the only code that
  can make it slower.
- **`FlushAsync()`** never throws. It returns `true` when every event queued before the call is stored or permanently
  settled, after the `OnDrop`/`OnError` callbacks for those events have run. It has **no time limit of its own**:
  delivery of each batch is bounded (`MaxRetries`, `RequestTimeout`, five minutes per batch), and a blocking callback
  holds it. Pass a token or use `FlushAsync(TimeSpan)` / `Flush(TimeSpan)` for a hard limit.
- **`Flush(TimeSpan)`** blocks for at most the timeout (the deadline starts on your thread, even when the thread pool is
  busy) and cannot deadlock on a UI or classic ASP.NET synchronization context. Called from inside an `OnDrop`/`OnError`
  callback, it returns `false` at once instead of waiting on itself.
- **`DisposeAsync`** returns within `ShutdownTimeout` (10 seconds by default) plus at most 2 seconds to unwind a
  cancelled request, plus at most 5 seconds for pending callbacks. **`Dispose`** waits at most `ShutdownTimeout` plus 10
  seconds. Events not sent by then are reported once each through `OnDrop` (`DropReason.Shutdown`).
- **Memory** is bounded: at most `MaxQueueSize` queued events (each at most 256 KB), one in-flight batch (at most 5 MB),
  at most 4 abandoned requests, and at most `MaxQueueSize` (at least 1,000) pending callback notifications. Very large
  pre-parsed JSON (`JsonNode.Parse`) in metadata or change values is measured before it is refused, which builds its
  nodes in memory first, so do not pass untrusted, unbounded documents as event data (#212).
- **Secrets** never appear in Logbird's exception messages, log messages, metric tags or `ToString()` output: keys are only
  sent in the `Authorization` header, and messages name fields and codes, never values. `DroppedEvent.Json` and
  `LogbirdEventWarning.Reason` carry event data (after redaction) for your own handling.

## Redaction

Secrets are redacted by default. A key matching passwords, secrets, tokens, one-time codes, API keys,
authorization, cookies, credentials or private keys keeps its name, and its value becomes `[redacted]`. This applies
at any depth (actor, targets, context, metadata) and to the before and after values of matching change fields.
The default does not cover personal data, so add your own keys:

```csharp
options.Redaction.AddKeys("email", "phone", "iban");
```

**Identifier fields are never redacted**: actor, impersonator, executor and tenant ids, and each target's type and id.
They are structural; a redacted id would merge every identity into one and destroy the trail. If your pattern would match
one of them (for example `AddKeys("id")`), Logbird reports it once at startup through the logger and `OnError` and keeps
running, redacting everything else. To pseudonymise an id, transform it before recording, for example with a keyed hash.
This is stricter than today's TypeScript `redact()`, which redacts any matching key.

Otherwise redaction behaves like the TypeScript SDK's `redact()`. Set `Redaction.Enabled = false` to turn it off, or replace
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

`SearchAllAsync` follows cursors until the last page. Logbird's cursors are keyset-ordered and never repeat; as a guard
against a misbehaving server, the client stops with `LogbirdApiException` (`pagination_stalled`) if a cursor repeats within
its last 1,000 pages, and you can bound every iteration with `LogbirdReadOptions.MaxPages` (code `page_limit` when more
pages remain).

`ForTrail` builds the same query as the TypeScript SDK's `trailQuery`. With `targetType`, it matches a target of exactly
that type and id together (the `record:` query field); with only `targetId`, any target with that id. Every value is
quoted, and quotes, backslashes, `*` and line breaks are matched literally, so a value can never widen the search. A
trail with `targetType`, or with a selector that ends in `*` or contains a carriage return, needs Logbird 0.2.0 or later
(older servers read those differently): the read client checks the server's version once (from its public OpenAPI
document) and throws `LogbirdApiException` (`server_too_old` or `server_version_unknown`) instead of sending it. `ForTrail` throws `ArgumentException` when it has no selector or query, or for an empty selector (pass `null`
to leave one out), so a bug cannot silently widen a history search to the whole project. A search filter is not authorization. When you show history to your own customers, check that the signed-in user
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

The wire format follows the TypeScript SDK byte for byte for the same input: field names, the envelope's field order
(an event built in TypeScript with its properties in a different order serializes them in that order, which the server
treats as the same content), `JSON.stringify` string escaping
(emoji and other non-ASCII text stay raw, lone surrogates are escaped, never replaced), JavaScript key order (integer-like
keys first) and JavaScript number layout (`1.0` as `1`, `1e21` as `1e+21`). An event sent from either SDK and replayed
from the other is therefore recognised as the same event. Tests serialize the same events in both SDKs and compare the
bytes, and a live test replays a TypeScript event from C#. Deliberate differences, where .NET can hold values JavaScript cannot:

- **Numbers are sent as the exact value you hold.** `float` and `double` use the shortest text that reads back as the
  same value (`1.1f` is sent as `1.1`, what you wrote), and integer types, `decimal` and raw JSON numbers from a
  `JsonElement` keep every digit (`1234567890123456789` and `1e-400` are sent as written). JavaScript would round these
  to binary64. `NaN` and infinities are sent as `null`, as `JSON.stringify` does. The golden comparison covers the values
  both SDKs can represent; a test lists these differences.
- `OccurredAt` is always sent as UTC with milliseconds (`2026-11-22T08:00:00.123Z`), the form the TypeScript SDK
  generates by default.
- Identifier fields are never redacted (see Redaction).
