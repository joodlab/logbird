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
