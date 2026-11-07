---
title: Developers — Logbird
description: Send audit events from TypeScript, Hono, TanStack Start, Vue, Nuxt or any HTTP client. Envelope guide, workers, delivery semantics and limits.
path: /developers
---

# Developers

## intro

- **id:** `intro`
- **eyebrow:** Developers
- **heading (H1):** Add an audit log in an afternoon. Keep it for years.
- **body:** Send events over HTTP or with the TypeScript SDK. Only `action` is required, so you can start with one line
  and fill in the envelope as you go. This page covers the SDK, the envelope, workers, delivery guarantees and limits.
  The full API reference is served by your own Logbird server at `/docs`.
- **cta:** Quickstart ↓ `#quickstart` · Self-host a server → `/self-hosting`
- **visual:** none

## quickstart

- **id:** `quickstart`
- **eyebrow:** SDK quickstart
- **heading:** Install, create a client, track an event.
- **body:** The SDK has no dependencies. It runs on Node 22+ and in modern runtimes with Fetch and Web Crypto. It
  batches events, retries failures and gives each event an id and a timestamp if you don't.
  <!-- source: packages/sdk/README.md -->
- **install (labelled "After the first npm release"):**

  ```sh
  npm install @logbird/sdk
  ```

  Small print: "The packages publish to npm with the first release, when the repository opens."
  <!-- source: docs/roadmap.md P0-3; npm registry 404 for @logbird/sdk on 2026-11-07 -->
- **code sample:**

  ```ts
  import { Logbird } from '@logbird/sdk';

  const client = new Logbird({
    endpoint: process.env.LOGBIRD_ENDPOINT, // your Logbird origin, e.g. https://audit.example.com
    apiKey: process.env.LOGBIRD_INGEST_KEY, // lb_ingest_...
    enabled: Boolean(process.env.LOGBIRD_INGEST_KEY), // off locally when no key is set
    defaults: { environment: 'production' },
    onError: (error) => console.error(error.message),
  });

  client.track({
    action: 'booking.cancelled',
    actor: { type: 'user', id: 'usr_42', name: 'Lina Haddad' },
    tenant: { id: 'biz_7', name: 'Azure Hotels' },
    targets: [{ type: 'booking', id: 'bk_1042', name: 'Booking #1042' }],
    changes: [{ field: 'status', before: 'confirmed', after: 'cancelled' }],
  });

  await client.flush(); // send now; rejects if delivery fails
  await client.shutdown(); // on exit: stop accepting events and drain the queue
  ```

- **bullets:**
  - `track(event)` never throws and never waits for the network.
  - `flush()` and `shutdown()` reject if delivery fails, so handle them.
  - Call `shutdown()` from your host's own exit hook. The SDK installs no process handlers.
  - Keep ingest keys on the server. Never ship one in a browser bundle.
  <!-- source: packages/sdk/README.md; docs/integrations.md §Design -->
- **side note ("Redaction"):** `beforeSend: redact()` deep-copies each event and replaces passwords, tokens, API keys,
  cookies and similar keys with `[redacted]` before sending. Add your own patterns for email or phone numbers; the
  default list covers secrets, not all personal data.
  <!-- source: packages/sdk/README.md §Host context options -->
- **visual:** code sample

## http

- **id:** `http`
- **eyebrow:** No SDK? Use HTTP.
- **heading:** One request, one to a thousand events.
- **body:** `POST /v1/events` accepts one event, a JSON array, or `{ "events": [...] }`. Authenticate with an ingest
  key. A `202` means ClickHouse has the rows.
  <!-- source: docs/SPEC.md §2, §5 -->
- **code sample:**

  ```sh
  curl https://audit.example.com/v1/events \
    -H "Authorization: Bearer $LOGBIRD_INGEST_KEY" \
    -H 'Content-Type: application/json' \
    -d '[{"action":"booking.cancelled","actor":{"type":"user","id":"usr_42"}},
         {"action":"payment.refunded","actor":{"type":"user","id":"usr_42"}}]'
  ```

- **visual:** code sample

## envelope

- **id:** `envelope`
- **eyebrow:** The envelope
- **heading:** Six fields that make an audit log useful.
- **body:** Logbird stores anything you send. These recommended fields become indexed columns, each one fills a page
  in the console, and the conformance score tells you how many of them an event has.
  <!-- source: docs/concepts.md; docs/SPEC.md §3 -->
- **table:**

  | Field | Answers | Example |
  | --- | --- | --- |
  | `actor` | Who caused it | `{ type: "user", id: "usr_42", name: "Lina Haddad" }` |
  | `executor` | What did the work, and on which try | `{ type: "worker", id: "refunds-worker", jobId: "job_981", attempt: 2 }` |
  | `impersonator` | Which staff member acted for the actor | `{ id: "usr_1", name: "Support agent" }` |
  | `tenant` | Whose account | `{ id: "biz_7", name: "Azure Hotels" }` |
  | `targets` | Which records | `[{ type: "booking", id: "bk_1042" }]` |
  | `changes` | What changed | `[{ field: "status", before: "confirmed", after: "cancelled" }]` |
  | `context.operationId`, `context.parentEventId` | Which unit of work, and what caused this event | `op_cancel_bk_1042` |

- **rules (bullets):**
  - **The actor is who asked; the executor is what did the work.** A refund Lina requested and a queue worker
    carried out has `actor = Lina`, `executor = refunds-worker`.
  - **Scheduled jobs nobody triggered** use `actor.type: "system"`.
  - **When support acts for a customer,** the customer stays the actor and the staff member goes in `impersonator`.
  - **Never send secrets in `changes`.** Send `"[redacted]"` to record that a secret changed.
  - **Everything else is kept.** Custom top-level keys and anything under `metadata` become searchable attributes,
    for example `metadata.channel:whatsapp`.
- **worked example (condensed):** "Lina cancels booking #1042. The API records the cancellation and queues a refund.
  The refund worker fails once, then succeeds on attempt 2."

  ```json
  [
    {
      "id": "evt_cancel_bk_1042",
      "action": "booking.cancelled",
      "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad" },
      "executor": { "type": "api", "id": "api-server" },
      "tenant": { "id": "biz_7", "name": "Azure Hotels" },
      "targets": [{ "type": "booking", "id": "bk_1042" }],
      "changes": [{ "field": "status", "before": "confirmed", "after": "cancelled" }],
      "context": { "operationId": "op_cancel_bk_1042" }
    },
    {
      "action": "payment.refunded",
      "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad" },
      "executor": { "type": "worker", "id": "refunds-worker", "jobId": "job_981", "attempt": 2 },
      "tenant": { "id": "biz_7", "name": "Azure Hotels" },
      "targets": [{ "type": "payment", "id": "pay_77" }, { "type": "booking", "id": "bk_1042" }],
      "context": { "operationId": "op_cancel_bk_1042", "parentEventId": "evt_cancel_bk_1042" }
    }
  ]
  ```

  Caption: "Both events land on Lina's page, Azure Hotels' page and booking bk_1042's page. The operation page shows
  the refund nested under the cancellation." <!-- source: docs/concepts.md §Worked example -->
- **cta:** Full concepts guide → `docs/concepts.md` (repo doc; link target pending, see `README.md`)
- **visual:** diagram: a two-node tree. Top node "booking.cancelled · API server · Lina Haddad"; child node
  "payment.refunded · Refunds worker · attempt 2". Both sit inside a box labelled `op_cancel_bk_1042`. To the right, three
  chips show where the events appear: "Actors: Lina Haddad", "Tenants: Azure Hotels", "Records: booking:bk_1042".

## integrations

- **id:** `integrations`
- **eyebrow:** Integrations
- **heading:** Middleware for the stacks we run.
- **body:** First-party packages for Hono, TanStack Start, Vue and Nuxt. On the server, the Hono, TanStack Start
  and Nuxt packages give you an `audit(action, partialEvent)` function per request. It resolves the actor, tenant, request id and operation id when
  you call it, so identity set by a per-route auth guard is still picked up. `audit()` returns the event id straight
  away and never waits for delivery.
  <!-- source: docs/integrations.md; packages/integrations/*/README.md -->
- **tabs:**
  - **Hono** (`@logbird/hono`):

    ```ts
    import { Hono } from 'hono';
    import { Logbird } from '@logbird/sdk';
    import { logbird, type AuditVariables } from '@logbird/hono';

    type User = { id: string; name: string };
    const client = new Logbird({
      endpoint: process.env.LOGBIRD_ENDPOINT,
      apiKey: process.env.LOGBIRD_INGEST_KEY,
      onError: console.error,
    });
    const capture = logbird({
      client,
      actor: (c) => {
        const user = c.get('user') as User | undefined; // set by your auth middleware
        return user ? { type: 'user', id: user.id, name: user.name } : undefined;
      },
      autoTrack: {}, // also records POST, PUT, PATCH and DELETE requests automatically
    });

    const app = new Hono<{ Variables: AuditVariables & { user?: User } }>();
    app.use(capture);
    app.post('/records', (c) => {
      c.var.audit('record.created', { targets: [{ type: 'record', id: 'rec_123' }] });
      return c.json({ ok: true });
    });
    // In your shutdown handler: await capture.shutdown();
    ```

  - **TanStack Start** (`@logbird/tanstack-start`): request middleware plus function middleware; call
    `context.audit(...)` inside server functions. Includes `readAuditTrail` and `trailQuery` for history routes.
  - **Vue** (`@logbird/vue`): `useAuditTrail` and a headless `AuditTimeline` that read history through *your*
    authenticated backend, with loading, error, refresh and load-more states.
  - **Nuxt** (`@logbird/nuxt`): a Nitro plugin adds `event.context.audit`. A built-in history route denies every
    request until your `authorize(event, query)` hook returns a trusted query.
- **limit line:** Express, Next.js, Laravel and Django are planned. We'll add them when we use those stacks
  ourselves. <!-- source: docs/integrations.md (intro) -->
- **visual:** code sample

## workers

- **id:** `workers`
- **eyebrow:** Workers and jobs
- **heading:** Keep the actor when the work moves to a queue.
- **body:** `audit.carrier()` packs the operation id, request id, parent event, actor and tenant into plain JSON you
  put on the job. On the worker, `jobAudit()` turns it back into an `audit` function. The executor is filled from
  the job's queue, id and attempt number. There's no BullMQ dependency; any job object with
  `id`, `name`, `queueName` and `attemptsMade` works.
  <!-- source: packages/sdk/README.md §Requests and workers; packages/sdk/src/integration.ts (JobAuditOptions) -->
- **code sample:**

  ```ts
  // In the request handler
  const eventId = c.var.audit('booking.cancelled', { targets: [{ type: 'booking', id: 'bk_1042' }] });
  const carrier = await c.var.audit.carrier({ parentEventId: eventId });
  await refunds.add('refund', { bookingId: 'bk_1042', carrier });

  // In the worker
  import { jobAudit } from '@logbird/sdk/integration';

  new Worker('refunds', async (job) => {
    const audit = jobAudit({ client, job, carrier: job.data.carrier });
    // ...refund the payment
    audit('payment.refunded', { targets: [{ type: 'booking', id: job.data.bookingId }] });
    await audit.pending();
  });
  ```

- **limit line:** A carrier is trusted internal data for correlation, not proof of identity.
- **visual:** code sample

## delivery

- **id:** `delivery`
- **eyebrow:** Delivery semantics
- **heading:** What happens between `track()` and the `202`.
- **bullets:**
  - **Batched.** Events go in batches of up to 100, or every second, whichever comes first.
  - **Retried.** Rate limits (`429`), server errors and network failures are retried with exponential backoff and
    jitter, up to 5 times. A numeric `Retry-After` is honoured.
  - **Acknowledged after storage.** The server answers `202` only once ClickHouse has the rows.
  - **At least once.** A retry after a lost response can store an event twice. Counts may include duplicates.
  - **Bounded under outage.** The queue holds up to 10,000 events by default. When it's full, `dropPolicy: 'oldest'`
    (the default) or `'newest'` decides what goes, and `onDrop` reports each event dropped.
  - **In memory.** A crash before the server acknowledges can lose pending events. Call `shutdown()` on exit.
  - **Partial batches.** Events without an `action` are rejected one by one, and the rest are stored.
    Permanent errors other than `429` drop the batch and report it through `onError`.
  <!-- source: packages/sdk/README.md (defaults: 100 rows, 1000 ms, 5 retries; maxQueueSize 10,000); docs/SPEC.md §2; docs/integrations.md -->
- **visual:** none

## limits

- **id:** `limits`
- **eyebrow:** Ingest limits
- **heading:** The numbers to design around.
- **table:**

  | Limit | Value |
  | --- | --- |
  | Events per request | 1 to 1000 |
  | Request size | 5 MB |
  | Event size | 256 KB |
  | Attributes per event | 256 keys, 6 levels deep, values up to 2 KB |
  | `occurredAt` | ISO-8601 or epoch milliseconds, from 3650 days ago to 24 hours ahead |
  | Ingest rate (default, per project) | 3000 requests a minute |
  | Read rate (default, per project) | 1200 requests a minute |

  <!-- source: docs/SPEC.md §3 normalization, §5 -->
- **bullets:**
  - Rate limits are shared by all keys of the same kind in a project, across replicas. Self-hosters can change them.
  - Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`. A `429` includes `Retry-After`.
  - An unusable `occurredAt` never drops the event. It is stored at receive time, the original value is kept, and
    the response lists a warning.
- **visual:** none

## read-api

- **id:** `read-api`
- **eyebrow:** Read API
- **heading:** Read your own history back.
- **body:** `GET /v1/events` with a read key returns matching events, newest first, up to 200 per page, with a
  `nextCursor` for the next page. `GET /v1/events/:eventId` returns one event. Without `from` and `to`, the range is
  the last 24 hours.
  <!-- source: packages/contracts/src/api.ts (searchQuerySchema, rangeQuerySchema); routes.ts -->
- **code sample:**

  ```ts
  import { readAuditTrail, trailQuery } from '@logbird/sdk/read';

  // Server only. First check that the signed-in user may see this booking.
  const page = await readAuditTrail(
    { endpoint: process.env.LOGBIRD_ENDPOINT!, readKey: process.env.LOGBIRD_READ_KEY! },
    trailQuery({
      target: { type: 'booking', id: 'bk_1042' },
      tenant: 'biz_7',
      range: { from: '2026-01-01T00:00:00Z', to: new Date().toISOString() },
    }),
  );
  // page.data: events; page.nextCursor: pass back as `cursor` for the next page
  ```

- **limit line:** A read key can read the whole project. A query filter is not authorization: your backend must
  check the tenant and record on every request, including each next page. The read API accepts the query language,
  not SQL mode. Tenant-scoped read tokens are on the roadmap.
  <!-- source: docs/integrations.md §Design; docs/query-language.md; docs/roadmap.md P1-1 -->
- **visual:** code sample

## reference

- **id:** `reference`
- **eyebrow:** API reference
- **heading:** Your server documents itself.
- **body:** Every Logbird API server serves its OpenAPI document at `/openapi.json` and an interactive reference
  (Scalar) at `/docs`, so the reference always matches the version you run. In the bundled Compose setup the API
  server listens only on the private network, and the public origin forwards only `/api`, `/v1` and the health
  checks. Open the reference from inside that network, or at `localhost:4601` when you run from source.
  <!-- source: docs/SPEC.md §2, §5; apps/server/src/app.ts (/docs, /openapi.json); apps/app/server/proxy.ts (proxies /api, /v1, /health, /livez, /readyz only); CONTRIBUTING.md (API: localhost:4601) -->
- **cta:** Self-host a server → `/self-hosting`
- **visual:** none. A capture of `/docs` doesn't exist yet; one is needed if this section gets an image.
