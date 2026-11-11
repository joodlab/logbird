# Concepts: actors, tenants, executors, records and operations

Logbird accepts any JSON object as an event; only `action` is required. A handful of envelope fields
([SPEC §3](SPEC.md#3-recommended-event-envelope)) are lifted into indexed columns, and each of them fills one
of the console's directory pages. Every entity on those pages has its own profile with a timeline of every
event that mentions it.

| Envelope field | Console page | Answers | Example |
| --- | --- | --- | --- |
| `actor: { type, id, name, email }` | **Actors** | *Who* caused the action | a user, an API key, an integration, the scheduler |
| `tenant: { id, name }` | **Tenants** | *In which customer's account* it happened | `biz_7` "Azure Hotels" |
| `executor: { type, id, name, jobId, attempt }` | **Executors** (URL `/workers`) | *What* performed it, and on which try | the API server, a queue worker, a cron job |
| `targets: [{ type, id, name }]` | **Records** | *What* was changed | a booking, a room, a user |
| `context.operationId` | **Operations** (opened from an event) | *Which unit of work* it belongs to | one request + every job it spawned |

## Actors — who asked

The actor is the party responsible for the action: a person (`type: "user"`), an API key (`api_key`), an
integration (`integration`), another service (`service`) or the platform itself (`system`). Scheduled jobs that
nobody triggered use `actor.type: "system"`. When support staff act on a customer's behalf, the customer stays
the actor and the staff member goes in `impersonator`.

## Tenants — whose account

The tenant is the customer, workspace or account the action happened in. Sending it on every event is what lets
you answer "what happened in this customer's account last week?" with one click, and what lets you expose a
per-customer history through the read API.

## Executors — what did the work

The executor is the piece of *your* system that physically performed the action: `api`, `worker`, `scheduler`,
`webhook`, `script` or `service`. Background work also carries `jobId` and `attempt`, so a retried job shows up as
attempt 2, 3, … on the same executor. The console labels this page **Executors**; its URL stays `/workers` for
compatibility.

**The actor is who asked; the executor is what did the work.** A refund that Lina requested but a queue worker
carried out has `actor = Lina` and `executor = refunds-worker`.

## Records (targets) — what changed

`targets` lists every record the action touched, one `{ type, id, name }` entry per record. Records are keyed by
`type` + `id`, so `booking:bk_1042` and `payment:bk_1042` are different records. Put field-level before/after
values in `changes` (never secrets — send `"[redacted]"` to record that a secret changed).

## Operations — how events relate

`context.operationId` groups everything one logical operation did: the API request, the jobs it enqueued, the
retries of those jobs and every record they changed. `context.parentEventId` links an event to the event that
caused it, forming a causation tree inside the operation. Open any event in the Explorer and follow its
operation to see the whole chain, or search `operation:<id>`.

## Worked example: a cancellation and its refund

Lina, a user of the Azure Hotels account, cancels booking #1042 through your API. The API server records the
cancellation and enqueues a refund. The refund worker fails on its first try (payment provider timeout — you may
record that as an `outcome: "failure"` event too) and succeeds on attempt 2.

**Event 1 — the API cancels the booking**

```json
{
  "id": "evt_cancel_bk_1042",
  "action": "booking.cancelled",
  "occurredAt": "2026-11-04T14:32:10.123Z",
  "description": "Lina cancelled booking #1042",
  "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad" },
  "executor": { "type": "api", "id": "api-server", "name": "API server" },
  "tenant": { "id": "biz_7", "name": "Azure Hotels" },
  "targets": [
    { "type": "booking", "id": "bk_1042", "name": "Booking #1042" },
    { "type": "room", "id": "room_12", "name": "Room 12" }
  ],
  "changes": [{ "field": "status", "before": "confirmed", "after": "cancelled" }],
  "context": { "operationId": "op_cancel_bk_1042", "requestId": "req_abc" }
}
```

**Event 2 — a queue worker refunds it, on attempt 2**

```json
{
  "id": "evt_refund_bk_1042",
  "action": "payment.refunded",
  "occurredAt": "2026-11-04T14:32:41.870Z",
  "description": "Refunded €240.00 for booking #1042",
  "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad" },
  "executor": { "type": "worker", "id": "refunds-worker", "name": "Refunds worker", "jobId": "job_981", "attempt": 2 },
  "tenant": { "id": "biz_7", "name": "Azure Hotels" },
  "targets": [
    { "type": "payment", "id": "pay_77", "name": "Payment pay_77" },
    { "type": "booking", "id": "bk_1042", "name": "Booking #1042" }
  ],
  "changes": [{ "field": "status", "before": "captured", "after": "refunded" }],
  "context": { "operationId": "op_cancel_bk_1042", "parentEventId": "evt_cancel_bk_1042" }
}
```

The actor is Lina on both events: Lina asked for the refund, and the worker only carried it out. Only the
executor changes.

**Where each entity shows up**

| Page | Entry | Events on its timeline |
| --- | --- | --- |
| Actors | Lina Haddad (`usr_42`, user) | both |
| Tenants | Azure Hotels (`biz_7`) | both |
| Executors | API server (`api-server`, api) | event 1 |
| Executors | Refunds worker (`refunds-worker`, worker) — job `job_981`, attempt 2 | event 2 |
| Records | Booking #1042 (`booking:bk_1042`) | both |
| Records | Room 12 (`room:room_12`) | event 1 |
| Records | Payment pay_77 (`payment:pay_77`) | event 2 |
| Operations | `op_cancel_bk_1042` | both, with event 2 nested under event 1 via `parentEventId` |

Useful Explorer queries for this example: `actor:usr_42`, `tenant:biz_7`, `executor:refunds-worker`,
`target:bk_1042 target.type:booking`, `operation:op_cancel_bk_1042`, `job:job_981`.

Logbird records its own management and authentication activity in a workspace stream. See the [activity action catalogue](workspace-audit.md) for actor, target, metadata and delivery semantics.
See [event exports](exports.md) for complete original payloads, normalized CSV/JSONL, versioned schemas, fixed query clocks and file-to-record verification.

## Event ids and retries

An id names one immutable event within a project, across every timestamp. An exact
retry is accepted without inserting or incrementing rollups again. Object keys may
be reordered recursively; array order and string contents must stay identical.
Identity includes the full input, including values outside indexing caps, and the
resolved timestamp. Omitted or invalid `occurredAt` keeps the first receipt's clock.

The SDK generates ids and timestamps once before queuing. If you use deterministic
ids across separate `track()` calls, resend identical content, including `occurredAt`
and `executor.attempt`; a new call otherwise gets a fresh timestamp. A different
event with the same id is rejected with `duplicate_id_conflict: ...`; the original
is kept. Send a correction with a new id and `context.parentEventId` pointing to it.
The SDK calls `onDrop` for that event and `onError` with the reason.

`503 ingest_pending` and `503 ingest_unavailable` mean retry unsettled events,
honoring `Retry-After`. Healthy siblings commit before a pending response and remain
idempotent on retry. Pending details include `accepted`, `ids`, `rejected`, `warnings`,
`indices` and `eventIds`. Every index outside `indices` is settled. Each rejected
entry has a `code` plus a code-first explanation in `reason`. The SDK retries these
responses; after its retry budget, only unsettled events stay queued and `flush()` rejects.
Retry `flush()` later. Unresolved writes recover automatically per project after a
bounded lease and ClickHouse queue drain. An id containing NUL, a lone surrogate,
or more than 256 UTF-16 code units after trimming is rejected individually as
`invalid_event_id`. Earlier releases truncated long ids; this release rejects them.
Use string ids: numeric ids generate a fresh UUID and a warning, so convert a
numeric source id with `String(id)` before sending it.

Rejection codes appear in `rejected[].code`; retryable HTTP codes appear in
`error.code`. Every index outside pending `indices` is settled. Use the full
`details` response (`accepted`, `ids`, `rejected`, `warnings`, `indices`, `eventIds`).

| Code | Meaning | What to do / expected timing |
| --- | --- | --- |
| `invalid_event` | Invalid event fields or a definite native storage parse failure. | Fix the reported indices in `rejected`. Healthy siblings are accepted (202); all rejected gives `accepted: 0`. |
| `unverified_after_parse_failure` | Isolation stopped before checking this proven-unwritten row; it is not proven invalid. | Terminal 202 for clients without `Logbird-Retry: subset`, once no other rows need retry. Resend individually if needed. |
| `invalid_event_id` | Unsafe or oversized string id. | Use valid Unicode without NUL, at most 256 UTF-16 units after trimming. |
| `duplicate_id_conflict` | The id belongs to different content. | Keep the original; send corrections with a new id and context.parentEventId. |
| `stored_event_unreadable` | Retained evidence cannot be compared. | Keep the evidence. Send a correction with a new id; ask the operator to inspect storage. |
| `ingest_pending (503)` | Some writes remain unresolved. | Honor Retry-After: one second for unchecked, proven-unwritten rows; about 70 seconds for ambiguity; up to 10 minutes for a ready claim. |
| `ingest_unavailable (503)` | Identity lookup or storage is unavailable. | Retry unsettled events with Retry-After; definite non-parse storage failures without held claims use five seconds. The operator may need to restore service. |
| `project_busy (503)` | A project maintenance lock is held. | Retry with Retry-After after the current operation releases its lock. |
| `retention_unavailable (503)` | Project data is being rebuilt. | Retry reads with Retry-After. Interrupted repairs resume through the worker; the hourly sweep is the fallback. |

Automatic recovery also runs hourly. Persistent service or permission errors must
be fixed before recovery can settle the claim; honor the server's Retry-After.

Search normalization uses `toWellFormed()` for indexed strings, target arrays,
changes values and rejected occurredAt copies; raw payload and v1 identity keep
original Unicode. A lone surrogate in a flattened attribute key rejects the event
before INSERT (`invalid_event: Attribute keys must be valid Unicode`); valid pairs
remain verbatim, avoiding key collisions. Isolation is defence in depth for unknown
parse triggers. Its first named row is checked alone; a written canary logs a mismatch
and switches to bisection. Prefix and canary statements share the isolation budgets.

Clients declaring `Logbird-Retry: subset` get unchecked rows in `503 ingest_pending`
indices and converge by retrying only unsettled events, byte-identically. About five
leading bad rows fit per attempt under the byte budget. The SDK always sends this header,
maps subset indices back to original events, and does not charge shrinking progress
attempts against `maxRetries` (total attempts are bounded by batch length plus retries).
Incomplete or malformed details keep the previous body. Exhaustion requeues only
unsettled events; retry `flush()` after `onError`.

Old SDKs and raw clients without the header instead receive terminal 202: written
rows accepted, proven-bad rows `invalid_event`, unchecked rows `unverified_after_parse_failure`.
If ambiguous writes, held-claim conflicts or other failures still require retry, all
clients get 503 and unchecked rows remain unresolved. Identical retries skip confirmed
rows and reach terminal 202 after pending writes settle through recovery. Proxies must
allow `Logbird-Retry`; stripping it safely falls back to 202 but rejects unchecked rows.
