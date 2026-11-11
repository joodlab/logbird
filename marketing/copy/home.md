---
title: Logbird — open-source audit logs for your product
description: Send who-did-what events over HTTP or the SDK, search them, and self-host it. MIT-licensed, built on ClickHouse. Logbird Cloud waitlist open.
path: /
---

# Home

> **Cloud open (`WEB_APP_URL` set).** Primary CTA "Request access"; the line under the hero actions reads "Logbird Cloud
> is in early access: sign-ups are limited to invited teams for now. Already invited? Sign in." The open-source
> quickstart pulls the published images of the latest release (see self-hosting.md).

## hero

- **id:** `hero`
- **eyebrow:** Open-source audit logs · MIT
- **heading (H1):** Retrace every step.
- **body:** Logbird is the audit log for your product. Send who-did-what events over HTTP or the SDK. Search them,
  follow any user, customer account or record, and run it on your own servers.
- **cta (primary):** Join the waitlist → `/contact`
- **cta (secondary):** Self-host it → `/self-hosting` (only once the repository is public; until then "Self-host when
  the source opens" → `/contact?interest=self-host`, see `README.md` § Self-host CTA rule)
- **code sample (copy button):**

  ```sh
  curl http://localhost:4600/v1/events \
    -H "Authorization: Bearer $LOGBIRD_INGEST_KEY" \
    -H 'Content-Type: application/json' \
    -d '{"action":"booking.cancelled"}'
  ```

  Caption under the snippet: "That's a valid event. Only `action` is required."
  <!-- source: README.md Quickstart; docs/SPEC.md §1.1 -->
- **small print under the CTAs:** Source on GitHub — coming soon. Logbird Cloud is not open yet.
- **visual:** `marketing/media/staydesk/explorer-light.webp` (dark-mode pair:
  `marketing/media/staydesk/explorer-dark.webp`).

## for-developers

- **id:** `developers`
- **eyebrow:** For developers
- **heading:** One call per action. No schema to migrate.
- **body:** Any JSON object with an `action` string is a valid event. Add the fields you have: who did it, in which
  customer account, to which records, what changed. Logbird lifts the fields it knows into indexed columns and keeps
  everything else as searchable attributes. Off-standard events are stored, never dropped.
  <!-- source: docs/SPEC.md §1.1, §3 normalization rules -->
- **bullets:**
  - A TypeScript SDK with batching, retries and an explicit `flush` and `shutdown`.
  - Middleware for Hono, TanStack Start and Nuxt; a Vue read composable. <!-- source: docs/integrations.md (Vue is useAuditTrail/AuditTimeline, a reader, not middleware) -->
  - `jobAudit` for queue workers: the job keeps the original actor and joins the request's operation.
    <!-- source: packages/sdk/README.md §Requests and workers -->
  - A conformance score on every event, so you can see which recommended fields you're missing.
- **code sample:** (tabs "Route" and "Worker")

  ```ts
  // Route (Hono)
  app.post('/bookings/:id/cancel', async (c) => {
    const id = c.req.param('id');
    // ...cancel the booking
    const eventId = c.var.audit('booking.cancelled', {
      targets: [{ type: 'booking', id }],
      changes: [{ field: 'status', before: 'confirmed', after: 'cancelled' }],
    });
    const carrier = await c.var.audit.carrier({ parentEventId: eventId });
    await refunds.add('refund', { bookingId: id, carrier });
    return c.json({ ok: true });
  });
  ```

  ```ts
  // Worker
  import { jobAudit } from '@logbird/sdk/integration';

  new Worker('refunds', async (job) => {
    const audit = jobAudit({ client, job, carrier: job.data.carrier });
    // ...refund the payment
    audit('payment.refunded', {
      targets: [{ type: 'booking', id: job.data.bookingId }],
    });
    await audit.pending();
  });
  ```

  Caption: "The actor is Lina on both events. The worker only carried it out." Full setup on `/developers`.
- **cta:** Read the developer guide → `/developers`
- **visual:** code sample

## for-operators

- **id:** `operators`
- **eyebrow:** For support, operations and compliance
- **heading:** Answer "what happened in this account?" in one search.
- **body:** The console is built for the people who get the question: support, operators, and whoever answers the
  auditor. Search every event, open a customer account or a single record, and see each change with its before and
  after values.
- **bullets:**
  - **Search** with `actor:usr_42 action:booking.* outcome:failure`, or write a guarded SQL `WHERE` expression.
  - **Entity pages** for every actor, tenant, executor and record, each with its own timeline.
  - **Operation trees** show one request, the jobs it spawned and every record they changed.
  - **Impersonation** is a first-class field: when support acts for a customer, both names are on the event.
  - **Retention** per project, from 7 days to 10 years. Expired events are permanently deleted.
    <!-- source: packages/contracts/src/api.ts RETENTION_OPTIONS (7, 14, 30, 60, 90, 180, 365, 730, 1825, 3650 days) -->
- **cta:** Take the product tour → `/product`
- **visual:** `marketing/media/staydesk/event-sheet-light.webp` (event detail with actor, executor,
  tenant, targets and changes).

## how-it-works

- **id:** `how-it-works`
- **eyebrow:** How it works
- **heading:** From one curl to a searchable history.
- **steps:**
  1. **Create a project.** Copy its ingest key. It's shown once and stored only as a hash.
     <!-- source: docs/SPEC.md §5 -->
  2. **Send events.** Over HTTP or the SDK: one event, or up to 1000 per request.
     <!-- source: docs/SPEC.md §5 size limits -->
  3. **Logbird stores them in ClickHouse.** The server answers `202` only after ClickHouse has the rows.
     <!-- source: docs/SPEC.md §2 ingestion path -->
  4. **Search, follow and keep them.** Use the console, or read them from your own backend with a read key. A worker
     deletes events older than the project's retention window, every hour.
     <!-- source: docs/SPEC.md §4 retention -->
- **visual:** diagram: four boxes left to right — "Your product (SDK or HTTP)" → "Logbird API" → "ClickHouse" →
  "Console and read API", with a "Retention worker" box under ClickHouse and a small "Postgres: workspaces, projects,
  keys" box under the API. Matches the README architecture diagram (`README.md` §Architecture).

## envelope

- **id:** `envelope`
- **eyebrow:** The envelope at a glance
- **heading:** Who caused it, what did the work, what changed.
- **body:** Only `action` is required. These fields fill the console's pages and make search precise.
- **code sample:**

  ```json
  {
    "action": "booking.cancelled",
    "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad" },
    "executor": { "type": "api", "id": "api-server" },
    "tenant": { "id": "biz_7", "name": "Azure Hotels" },
    "targets": [{ "type": "booking", "id": "bk_1042", "name": "Booking #1042" }],
    "changes": [{ "field": "status", "before": "confirmed", "after": "cancelled" }],
    "context": { "operationId": "op_cancel_bk_1042" }
  }
  ```

  <!-- source: docs/concepts.md worked example, event 1 (condensed) -->
- **annotations (one line each, placed beside the JSON):**
  - `actor`: who asked.
  - `executor`: what did the work, and on which attempt.
  - `tenant`: whose account.
  - `targets`: which records.
  - `changes`: before and after. Never secrets.
  - `operationId`: ties a request to the jobs it started.
- **cta:** The envelope guide → `/developers#envelope`
- **visual:** code sample

## open-source

- **id:** `open-source`
- **eyebrow:** Open source
- **heading:** MIT-licensed. Runs with Docker Compose.
- **body:** The whole product is in one repository: the API, the console, the retention worker, the SDK and the
  integrations. Self-hosting builds it from source on your server, so your events stay on your infrastructure.
  No images are published yet.
  <!-- source: LICENSE; docs/self-hosting.md -->
- **bullets:**
  - Bundled Docker Compose, a Coolify build, or your own Postgres, ClickHouse and Redis.
  - Automatic HTTPS with Caddy, or any reverse proxy you already run.
  - Source on GitHub — coming soon. The repository opens publicly soon.
- **cta:** Self-host it → `/self-hosting` (public repo only; see the CTA rule) · What's in the repository → `/open-source`
- **while the repository is private:** replace the quickstart code block with "Available when the repository opens.
  On one VM: clone, generate secrets, configure SMTP, build the four roles, then `docker compose up -d --no-build`. We'll
  publish the commands here the day the source is public." and a "Tell me when it opens" button → `/contact?interest=self-host`.
- **visual:** a new, reviewed capture (required before publication) (terminal: `docker compose ps` with the
  stack running). Check the terminal for paths or hostnames before use.

## guarantees

- **id:** `guarantees`
- **eyebrow:** Guarantees and limits
- **heading:** What Logbird promises, and where the promise ends.
- **bullets (two columns: "We guarantee" / "The limit")**
  - A `202` means the event is stored in ClickHouse. / Delivery is at least once; counts may include duplicates.
    <!-- source: docs/SPEC.md §2; README.md -->
  - The SDK batches and retries for you. / Its queue is in memory: a crash before the server acknowledges can lose
    pending events. <!-- source: packages/sdk/README.md -->
  - Any shape is accepted; only `action` is required. / Events without an `action` are rejected, one by one; the rest
    of the batch is stored. <!-- source: docs/integrations.md §Outage backpressure (ingest paragraph) -->
  - Retention deletes expired events for good. / There's no archive and no undo.
    <!-- source: docs/SPEC.md §1.4; capture 10-retention-preview.png -->
  - History starts the day you start sending. / There is no backfill.
    <!-- source: docs/SPEC.md §1.3 -->
- **cta:** Read how we handle data → `/security`
- **visual:** none (text block)

## final-cta

- **id:** `final-cta`
- **heading:** Start with one event.
- **body:** Self-host Logbird today, or join the waitlist for Logbird Cloud. (Public repo only. While private: "The source
  opens soon. Join the waitlist to hear when you can self-host Logbird, and when Logbird Cloud opens.")
- **cta (primary):** Join the waitlist → `/contact`
- **cta (secondary):** Self-host it → `/self-hosting`
- **visual:** none
