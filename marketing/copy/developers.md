---
title: Developers — Logbird
description: Send audit events from TypeScript, Hono, TanStack Start, Nuxt or any HTTP client, and show history with the Vue helpers. Envelope guide, workers, delivery semantics and limits.
path: /developers
---

Page text renders from `apps/web/src/content/developers.ts`; edit it there. This file is the brief: jobs, sources and owner notes.

# Developers

## intro

- **id:** `intro`
- **eyebrow:** Developers
- **heading (H1):** Add an audit log in an afternoon. Keep it for years.
- **body:** Send events over HTTP or with the TypeScript SDK. Only `action` is required, so you can start with one line
  and fill in the envelope as you go. This page covers the SDK, the envelope, workers, delivery guarantees and limits.
- **cta:** Quickstart ↓ `#quickstart` · Self-host a server → `/self-hosting`
- **visual:** none

## quickstart

- **id:** `quickstart`
- **eyebrow:** SDK quickstart
- **heading:** Install, create a client, track an event.
- **body:** The TypeScript SDK's capture entry point has no dependencies. It runs on Node 22+ and in modern runtimes with Fetch and Web Crypto. It
  batches events, retries failures and gives each event an id and a timestamp if you don't.
  <!-- source: packages/sdk/README.md -->
- **install (labelled "From source (not on npm yet)", shown once `WEB_GITHUB_PUBLIC=true`):**

  ```sh
  git clone --branch v<latest release> <WEB_GITHUB_URL>.git ../logbird
  pnpm -C ../logbird install
  pnpm add @logbird/sdk@link:../logbird/packages/sdk
  ```

  Small print: "The packages aren't on npm yet. The SDK exports TypeScript: run it with tsx or a bundler such as Vite
  or esbuild." While the repository is private: "The packages aren't on npm yet."
  <!-- source: packages/sdk/README.md (source install); npm registry 404 for @logbird/sdk on 2026-11-22 -->
- **code tabs:** TypeScript (the sample below) and .NET (`dotnetQuickstart` in `apps/web/src/content/developers.ts`: the
  same event with the `Logbird` package, its install command in a comment, no version number; compiled against
  `sdks/dotnet` when it changes). Live only after the maintainer verified the packages on nuget.org.
  <!-- source: sdks/dotnet/README.md § Install, § Record events -->
- **code sample:**

  ```ts
  import { Logbird } from '@logbird/sdk';

  const client = new Logbird({
    endpoint: process.env.LOGBIRD_ENDPOINT, // your Logbird origin, e.g. https://audit.example.com
    apiKey: process.env.LOGBIRD_INGEST_KEY, // lb_ingest_...
    enabled: Boolean(process.env.LOGBIRD_INGEST_KEY), // off locally when no key is set
    defaults: { environment: 'production' },
    onError: (error) => console.error(error.message), // capture errors, permanent rejections and background flush failures
    onDrop: (event) => console.warn('audit event dropped', event.action), // events the server rejects or a full queue discards
  });

  client.track({
    action: 'booking.cancelled',
    actor: { type: 'user', id: 'usr_42', name: 'Lina Haddad' },
    tenant: { id: 'biz_7', name: 'Azure Hotels' },
    targets: [{ type: 'booking', id: 'bk_1042', name: 'Booking #1042' }],
    changes: [{ field: 'status', before: 'confirmed', after: 'cancelled' }],
  });

  // flush() can reject, for example when retryable delivery (network, 429, 5xx) runs out of retries or the send
  // deadline passes. Unsettled events are then queued again, as far as the queue's capacity allows.
  // Permanent rejections don't reject flush(): they arrive through onError and onDrop.
  await client.flush().catch((error) => console.error('audit delivery pending', error));
  // On exit: stop accepting events and drain the queue. Can reject like flush().
  await client.shutdown().catch((error) => console.error('audit events left undelivered', error));
  ```

- **bullets:**
  - In TypeScript, `track(event)` never throws and never waits for the network.
  - `flush()` and `shutdown()` can reject, for example when retryable delivery (network, `429`, `5xx`) runs out of
    retries or the send deadline passes. Unsettled events are queued again, as far as the queue's capacity allows.
    Permanent rejections arrive through `onError` and `onDrop` instead.
    <!-- source: packages/sdk/src/index.ts send()/flush(); packages/sdk/README.md -->
  - Call `shutdown()` from your host's own exit hook. The SDK installs no process handlers.
  - Keep ingest keys on the server. Never ship one in a browser bundle.
  <!-- source: packages/sdk/README.md; docs/integrations.md §Design -->
- **side note ("Redaction"):** **Redaction:** in TypeScript, `beforeSend: redact()` deep-copies each event and replaces passwords, tokens, API keys,
  cookies and similar keys with `[redacted]` before sending. Add your own patterns for email or phone numbers; the
  default list covers secrets, not all personal data.
  <!-- source: packages/sdk/README.md §Host context options -->
- **visual:** code sample

## http

- **id:** `http`
- **eyebrow:** No SDK? Use HTTP.
- **heading:** One request, one to a thousand events.
- **body:** `POST /v1/events` accepts one event, a JSON array, or `{ "events": [...] }`. Authenticate with an ingest
  key. A `202` lists the stored event IDs in `ids` and rejected events in `rejected`.
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
- **heading:** The fields that make an audit log useful.
- **body:** Only an `action` string is required, and each event must fit the ingest limits. These recommended fields are normalized into columns: actor, tenant,
  executor, target and operation ids are indexed for search, and actors, workers, support agents, tenants, records and
  operations each get their own page in the console. The conformance score is the
  share of nine recommended checks an event passes.
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
  - **Everything else is kept.** Custom top-level keys and anything under `metadata` stay in the event's JSON and are
    indexed as searchable attributes, for example `metadata.channel:whatsapp`: up to 256 custom attributes per event, 6
    levels deep, text values indexed up to their first 2 KiB (a number too long to index stays in the event JSON).
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
<!-- planned call to action, not on the page yet: Full concepts guide → docs/concepts.md -->
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
- **limit line:** There are no Express, Next.js, Laravel or Django integrations. Use the TypeScript SDK or plain HTTP from
  those stacks. <!-- source: docs/integrations.md (intro). Not on docs/roadmap.md, so not called planned. -->
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
  - **Batched.** By default, events go in batches of up to 100, or every second, whichever comes first.
  - **Retried.** Rate limits (`429`), server errors and network failures are retried with exponential backoff and
    jitter. By default, five retries that make no progress end the attempt; a `503` that settles part of the batch
    counts as progress. A numeric `Retry-After` is honoured, capped at 60 seconds and the 5-minute send deadline.
  - **Acknowledged after storage.** On `202`, `ids` lists the accepted events and `rejected` names the entries that
    failed. An accepted event was written to ClickHouse by this request or an earlier identical one.
  - **At least once, stored once.** The SDK gives every event an id before it queues it, so a retry after a lost
    response reuses the stored event while the project retains it. Raw HTTP clients should send their own string `id`: a missing, blank or non-string id gets a new generated id on every retry. A string id is rejected with `invalid_event_id` if it contains NUL or an unpaired surrogate, or exceeds 256 UTF-16 code units after trimming.
  - **Bounded under outage.** The queue holds up to 10,000 events by default. When it's full, `dropPolicy: 'oldest'`
    (the default) or `'newest'` decides what goes, and `onDrop` reports each event dropped.
  - **In memory.** A crash before the server acknowledges can lose pending events. Call `shutdown()` on exit.
  - **Partial batches.** Each event is checked on its own. Rejected events, such as one without an `action` or an id
    conflict, are listed in `rejected`. On `202` the rest are accepted. When a `503` lists the
    unsettled events, retry only those; otherwise retry the whole batch with the same ids.
    Permanent errors other than `429` drop the batch and report it through `onError` and `onDrop`, without rejecting
    `flush()`.
  <!-- source: packages/sdk/README.md (defaults: 100 rows, 1000 ms, 5 retries; maxQueueSize 10,000); docs/SPEC.md §2; docs/integrations.md -->
- **visual:** none

## limits

- **id:** `limits`
- **eyebrow:** Ingest limits
- **heading:** The numbers to design around.
- **table:**

  | Events per request | 1 to 1000 |
  | Request size | 5 MB |
  | Event size | 256 KB |
  | Attributes per event | Up to 256 custom attributes indexed, 6 levels deep, text values indexed up to their first 2 KiB (a number too long to index stays in the event JSON) |
  | `occurredAt` | ISO-8601 or epoch milliseconds, from 3650 days ago to 24 hours ahead |
  | Ingest rate (default, per project) | 3000 requests a minute |
  | Read rate (default, per project) | 1200 requests a minute |

  <!-- source: docs/SPEC.md §3 normalization, §5 -->
- **bullets:**
  - Rate limits are shared by all keys of the same kind in a project, across replicas. Self-hosters can change them.
  - Authenticated responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` when the limiter can
    account for the request. A `429` includes `Retry-After`.
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
  not SQL mode. <!-- Scoped read access (0.2.0) is not described here until the maintainer confirms its production proof. -->
  <!-- source: docs/integrations.md §Design; docs/query-language.md; docs/roadmap.md P1-1 -->
- **visual:** code sample

## reference

- **id:** `reference`
- **eyebrow:** API reference
- **heading:** Your server documents itself.
- **body:** Every Logbird server serves its OpenAPI document at `/openapi.json` and an interactive reference
  at `/docs`, so the reference always matches the version you run. The API listener stays on the private
  network; your public origin forwards `/api`, `/v1`, the health checks and these two read-only reference paths, and
  nothing else. Open `https://your-logbird-origin/docs`, or `localhost:4600/docs` when you run locally.
  <!-- source: docs/SPEC.md §2, §5; docs/decisions.md (2026-11-08); apps/server/src/app.ts (/docs, /openapi.json); apps/app/server/proxy-paths.ts (proxies /api, /v1, /health, /livez, /readyz, /docs, /openapi.json only) -->
- **cta:** Self-host a server → `/self-hosting`
- **visual:** none. A capture of `/docs` doesn't exist yet; one is needed if this section gets an image.
