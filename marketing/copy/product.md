---
title: Product tour — Logbird
description: Search every event, follow actors, tenants, workers and records, and open operation trees. An hourly worker deletes events older than your project's retention window.
path: /product
---

Page text renders from `apps/web/src/content/product.ts` (the roadmap section from `apps/web/src/content/roadmap.ts`); edit it there. This file is the brief: jobs, sources and owner notes.

# Product tour

## intro

- **id:** `intro`
- **eyebrow:** Product
- **heading (H1):** Everything your team needs to answer "who did what".
- **body:** The Logbird console is for the people who operate your product: engineers on call, support, and whoever
  answers the auditor. It is not a portal for your end customers. To show history inside your own product, use the
  read API.
  <!-- source: docs/SPEC.md intro ("not an end-customer portal") -->
- **cta:** Self-host it → `/self-hosting` · Join the waitlist → `/contact`
- **visual:** `marketing/media/staydesk/overview-light.webp` / `marketing/media/staydesk/overview-dark.webp` (manifest id `overview`).

## explorer

- **id:** `explorer`
- **eyebrow:** Explorer
- **heading:** Every event, in one table.
- **body:** Pick a time range, type a query, and narrow it down with facets. Drag across the chart to zoom. Click a
  row to open the full event. The query, time range and columns live in the URL, so a link opens the same search for a
  teammate. A relative range such as the last hour resolves when they open it. Share an absolute range to preserve
  the time window, or a downloaded export to preserve the results.
  <!-- source: docs/SPEC.md §8 journey 4 -->
- **bullets:**
  - Facets with counts: click to include, Alt-click to exclude.
  - Configurable columns and infinite scroll.
  - Keyboard first: `/` focuses search, `j` and `k` move through events, `Esc` closes the panel, ⌘K opens the command
    palette.
  - Export the current results as CSV or JSONL. <!-- source: packages/contracts/src/routes.ts (export ?format=csv|jsonl) -->
- **visual:** clip `docs/media/walkthrough.webm` (manifest id `investigate`: sign in, search events, inspect changes and watch live tail).

## search

- **id:** `search`
- **eyebrow:** Search
- **heading:** A query language you already half know.
- **body:** Type `field:value` and Logbird suggests fields and values as you go. It covers what you'd expect from
  Lucene-style search: wildcards, negation, ranges, regex and groups. If you type KQL-style syntax like `f = v`, it
  offers to convert it.
  <!-- source: docs/query-language.md -->
- **code sample:**

  ```text
  actor:usr_42 action:booking.* -env:staging
  outcome:(failure OR denied) attempt:>2
  tenant.name:"Azure Hotels" occurredAt:>now-7d
  impersonator:*  metadata.channel:whatsapp
  ```

- **bullets:**
  - Fields are suggested from what your project actually sends, with how often each one appears.
  - Errors point at the exact token and say what was expected, for example "attempt is a number".
  - Nested fields are searchable by their dotted path, up to 6 levels deep. Each event indexes up to 256 custom attributes,
    text values indexed up to their first 2 KiB (a number too long to index stays in the event JSON). Search limits apply to the index. You can inspect the full parsed event as JSON.
    <!-- source: docs/SPEC.md §3 (flattening); packages/clickhouse/src/normalize.ts -->
- **visual:** `marketing/media/staydesk/query-suggestions-light.webp` (manifest id `query-suggestions`) under the query-language code sample.

## sql-mode

- **id:** `sql-mode`
- **eyebrow:** SQL mode
- **heading:** Or write a SQL `WHERE` expression, safely.
- **body:** Switch the bar to SQL and write a ClickHouse boolean expression, such as
  `job_attempt > 2 AND attributes['metadata.channel'] = 'whatsapp'`. You write only the condition. Logbird writes the
  rest of the statement.
- **bullets (the guard):**
  - **Parsed by ClickHouse.** Logbird asks ClickHouse for the expression's syntax tree and checks it before running
    anything.
  - **Allowlisted.** Only known columns and a fixed list of functions are allowed. Subqueries, joins, table
    functions, `SETTINGS` and system tables are rejected.
  - **Run as a restricted user.** Queries run as a separate read-only ClickHouse user with its own CPU, memory and
    row limits.
  - **Scoped to your project.** Database row policies limit that user to the project you're looking at, even if the
    expression is `1 OR 1`.
  <!-- source: docs/SPEC.md §5.1.2; docs/query-language.md §Security model -->
- **limit line (small print):** SQL mode is for the console only. The public read API accepts the query language,
  not SQL. A free-form SQL console isn't part of Logbird. <!-- source: docs/query-language.md -->
- **visual:** `marketing/media/staydesk/sql-rejected-light.webp` (manifest id `sql-rejected`: a subquery rejected before it runs).

## entity-pages

- **id:** `entities`
- **eyebrow:** Follow anything
- **heading:** A page for each actor, tenant, worker and record.
- **body:** Actors, tenants, executors and records in your events get their own pages (records from the first 64
  targets of each event). Each one shows an activity
  chart, its top actions, its outcome split, related entities and a full timeline. Directory pages list them all,
  most active first, with fuzzy search.
  <!-- source: docs/SPEC.md §8 journey 5; docs/concepts.md -->
- **bullets:**
  - **Actors:** who caused it. Users, API keys, integrations, the system.
  - **Tenants:** whose account. "What happened at Azure Hotels last week?" is one click.
  - **Executors:** what did the work. The API, each queue worker and cron job, with job ids and attempts.
  - **Records:** what changed. `booking:bk_1042` has a history of its own.
- **visual:** `marketing/media/staydesk/tenant-light.webp` (manifest id `tenant`).

## operations

- **id:** `operations`
- **eyebrow:** Operation trees
- **heading:** One request, every job it started, as a single tree.
- **body:** Send the same `operationId` on a request and the jobs it starts. Add `parentEventId` to say which event
  caused which. Logbird draws the tree: each step with its outcome, executor and timing. A failed first attempt and
  the retry that worked sit side by side.
  <!-- source: docs/concepts.md §Operations; docs/SPEC.md §8 journey 6 -->
- **visual:** `marketing/media/staydesk/operation-light.webp` (manifest id `operation`: a scheduler request, its jobs, failed attempts and
  the retries that worked; the durations are fixture data).

## event-detail

- **id:** `event-detail`
- **eyebrow:** Event detail
- **heading:** The full story of one event.
- **body:** Open any event to read it as a sentence: who did what, in which account, to which records, and how it
  ended. The actor and the executor are on separate cards. When a support agent acted for a customer, the agent
  appears beside the customer.
- **bullets:**
  - The before and after values you send, for the first 256 changes.
  - The causation breadcrumb, with a link to the whole operation.
  - Context ids (request, trace, IP), the indexed attributes, and the full parsed event as JSON.
  - Copy a link, or copy the event as a curl command.
  - Support work stands out: rows show "via support", the Done by support filter lists them, and each support agent
    has a page.
  <!-- source: docs/SPEC.md §8 journey 4 (event sheet); #69 (explorer columns, facet-sidebar, support-agent-profile) -->
- **visual:** `marketing/media/staydesk/event-sheet-light.webp` / `marketing/media/staydesk/event-sheet-dark.webp` (manifest id
  `event-sheet`). The impersonation still is set aside: it shows the card as it was before #69 ("Impersonator", not
  "Support"). Re-shoot it on master in a stack window, ideally with a "via support" row and the Done by support filter,
  before using it again.

## more

- **id:** `more-title` (the heading's id; the section has none of its own)
- **heading:** And the parts you use every day.

## live-tail

- **id:** `live-tail`
- **eyebrow:** Live
- **heading:** Watch events arrive during a deploy.
- **body:** Turn on Live and new events appear at the top of the table as they arrive, with your current query still
  applied.
- **limit line:** Live tail polls over HTTP. It doesn't use WebSockets, so it works behind any proxy.
  <!-- source: docs/self-hosting.md §Any reverse proxy -->
- **visual:** none (a compact card on the page).

## saved-views

- **id:** `saved-views`
- **eyebrow:** Saved views
- **heading:** Save the searches your team runs every week.
- **body:** Save a query, its time range and its columns as a view, in query or SQL mode. Views appear in the sidebar
  and in the search bar's suggestions. Anyone in the workspace can open them; members can delete their own.
  <!-- source: docs/SPEC.md §7.1, §8 journey 7 -->
- **visual:** none (a compact card on the page).

## setup

- **id:** `setup`
- **eyebrow:** Setup that checks itself
- **heading:** The setup page tells you what's still missing.
- **body:** Send your first event and the setup page notices on its own. It then checks your integration
  against your real events: for actors, tenants, executors and targets it shows the coverage and links to the events
  missing each one; for operation ids it shows the coverage and links to the events that have one. Reviewing retention and inviting your team are separate checklist items.
  <!-- source: docs/SPEC.md §8 journeys 2 and 10 -->
- **bullets:**
  - Onboarding picks up where you left off.
  - "Send a test event" and "Load sample data" show the console before you integrate. Sample data is 2000
    fictional events over seven days; it never counts as setup, and you can remove it.
    <!-- source: docs/SPEC.md §5 sample-data -->
  - A conformance score on every event, and a Fields page that shows coverage for the single-value core fields and
    the attributes your events carry in the selected range.
- **visual:** `marketing/media/staydesk/setup-light.webp` (manifest id `setup`). The onboarding stills were discarded because the page's
  snippet prints the ingest key.

## retention

- **id:** `retention`
- **eyebrow:** Retention
- **heading:** Keep events as long as you decide, then delete them.
- **body:** Each project keeps events for a window you choose, from 7 days to 10 years. New projects start at 90
  days. A worker deletes expired events every hour. Before you lower the window, Logbird shows how many events will
  be deleted. To confirm, you type the project's slug, and the purge starts right away.
  <!-- source: docs/SPEC.md §1.4, §4, §5 retention preview, §6 (retentionDays=90), §7.1; packages/contracts/src/api.ts RETENTION_OPTIONS -->
- **limit line:** Retention deletes are permanent. There's no archive and no undo. The count can change
  between preview and deletion.
- **visual:** `marketing/media/staydesk/retention-light.webp` (manifest id `retention`, light and dark: the current window, the policies and the purge status).

## workspace-activity

- **id:** `workspace-activity`
- **eyebrow:** Workspace activity
- **heading:** Logbird records its own management actions.
- **body:** Logbird records management actions (projects, keys, retention, invitations) in workspace activity. You read
  it with the same explorer.
  <!-- source: docs/SPEC.md §1.5, §8 journey 9. Don't say "each" or imply guaranteed or atomic capture until #73
  (atomic audit rows for management mutations) merges; strengthen in a follow-up then. -->
- **visual:** none (a compact card on the page).

## team

- **id:** `team`
- **eyebrow:** Workspaces and roles
- **heading:** Owners and admins manage it. Members use it.
- **body:** Sign-in is by emailed one-time code. There are no passwords. Owners and admins manage projects, keys,
  retention and invitations. Members search, export, save views and read workspace activity. The server checks every
  role on every request.
  <!-- source: docs/SPEC.md §7, §7.1; SECURITY.md -->
- **limit line:** SSO isn't available yet. It's on the roadmap.
- **visual:** none (a compact card on the page).

## read-api

- **id:** `read-api`
- **eyebrow:** Read API
- **heading:** Show history inside your own product.
- **body:** Give your customers a "History" tab. Your backend calls `GET /v1/events` with a read key and a query
  for that record and tenant, and checks that each returned event names that record, then returns the page to your UI. Results are paginated with a cursor. The
  Vue, Nuxt and TanStack Start packages include helpers for this.
  <!-- source: packages/contracts/src/routes.ts, api.ts; docs/integrations.md -->
- **limit line:** A read key can read the whole project. Your backend must check that the person asking may see
  that tenant or record, on every page it fetches. <!-- source: docs/integrations.md §Design -->
- **cta:** Read API on the developer page → `/developers`
- **visual:** code sample (see `developers.md` § read-api)

## webhooks

Held: this section ships with the 0.3.0 webhook delivery and merges only after 0.3.0 is deployed and checked in
production.

- **id:** `webhooks`
- **eyebrow:** Webhooks
- **heading:** Send matching events to your own endpoint.
- **job:** tell an operator that matching events can be pushed to their own HTTPS endpoint, chosen with the explorer's
  query language and narrowed by scope and masks, and state the delivery contract plainly: at least once, retried for
  up to 24 hours, signed with the Standard Webhooks headers. Never "guaranteed delivery", "exactly once" or
  "tamper-proof".
- **body:** Logbird sends each matching event to an HTTPS endpoint you choose. Choose which events with the same query
  language as the explorer, and narrow an endpoint to one tenant or one record, with field masks. Every delivery is
  signed with the Standard Webhooks headers; verify it with the TypeScript or .NET SDK.
  <!-- source: docs/SPEC.md § Webhook endpoint management (filterQuery, scope { tenantId?, target?, mask? }, Standard Webhooks headers); packages/sdk/README.md § Standard Webhooks; sdks/dotnet/README.md § Verify webhooks -->
- **bullets:**
  - Network failures, timeouts and responses other than `2xx` or `410 Gone` are retried with backoff for up to 24 hours. Delivery is at least once, so deduplicate by
    `webhook-id`. <!-- source: SPEC § Webhook endpoint management (retry schedule; "Receivers use the stable webhook-id to deduplicate") -->
  - A delivery log shows each delivery's status and its recent attempts for 30 days; resend a delivery or send a test
    ping. <!-- source: SPEC (deliveries endpoint, five most recent retained attempts, 30-day attempt and delivery retention, resend, test); apps/app/src/components/webhooks/delivery-log.tsx -->
  - The secret is shown once; rotate it with an overlap so receivers can switch. <!-- source: SPEC (create and rotate return the secret once; overlap default 86400 s, 0–604800) -->
  - An endpoint is disabled at once when it answers `410 Gone`, and after 50 consecutive failed deliveries (by
    default) or 24 hours of failures without a success. An email notice is then queued for the workspace's owners and admins. <!-- source: SPEC (gone_410, consecutive_failures, email to owners and admins); apps/worker/src/webhook-delivery.ts:503–510 (a notice row per owner or admin), apps/worker/src/webhook-notices.ts:22–30 (role checked again at send) -->
- **limit line:** At least once, not exactly once, and in no guaranteed order. A delivery that still fails after 24
  hours stops. Up to 10 endpoints per project; HTTPS only. <!-- source: SPEC (window expiry marks the delivery failed; up to 10 endpoints per project; HTTPS unless the self-host option WEBHOOKS_ALLOW_HTTP=true) -->
- **visual:** code sample, "A delivery": the request line, the three Standard Webhooks headers (an `lb1_` id) and an
  abbreviated event body. <!-- source: SPEC (POST body is the public event shape; lb1_ header ids) -->
- **owner note:** before this merges, add one sentence from T2's merged delivery-window docs (#359): events that arrive
  later than the window are skipped by the webhook and stay stored and searchable. A code comment marks the place in
  `apps/web/src/content/product.ts`.

## roadmap

- **id:** `roadmap`
- **eyebrow:** On the roadmap
- **heading:** What's on our roadmap.
- **body:** These are candidates from our public roadmap, not features or commitments. Order and timing can change.
- **bullets:** <!-- source: docs/roadmap.md (Customer-facing history; Later candidates), worded no stronger than it. Only items docs/roadmap.md or a milestone lists may appear here (maintainer rule, 2026-11-22), and not items already built: tenant-scoped read tokens and scoped exports are on master, unreleased, and not presented until their production proof. -->
  - Project-level redaction controls, behind the redaction your client already does.
  - Alerts on chosen actions.
  - Archive exports. <!-- signed webhooks left the roadmap with the 0.3.0 webhook delivery (§ webhooks) -->
  - Single sign-on for the console.
- **visual:** none
