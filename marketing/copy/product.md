---
title: Product tour — Logbird
description: Search every event, follow actors, tenants, workers and records, open operation trees, and keep data for exactly as long as you choose.
path: /product
---

# Product tour

## intro

- **id:** `intro`
- **eyebrow:** Product
- **heading (H1):** Everything your team needs to answer "who did what".
- **body:** The Logbird console is for the people who operate your product: engineers on call, support, and whoever
  answers the auditor. It is not a portal for your end customers. To show history inside your own product, use the
  read API (last section on this page).
  <!-- source: docs/SPEC.md intro ("not an end-customer portal") -->
- **cta:** Self-host it → `/self-hosting` · Join the waitlist → `/contact`
- **visual:** `marketing/captures/2026-11-07-site-console/overview-light.png` / `overview-dark.png` (manifest id `overview`).

## explorer

- **id:** `explorer`
- **eyebrow:** Explorer
- **heading:** Every event, in one table.
- **body:** Pick a time range, type a query, and narrow it down with facets. Drag across the chart to zoom. Click a
  row to open the full event. Everything lives in the URL, so a link shows a teammate exactly what you see.
  <!-- source: docs/SPEC.md §8 journey 4 -->
- **bullets:**
  - Facets with counts: click to include, Alt-click to exclude.
  - Configurable columns and infinite scroll.
  - Keyboard first: `/` focuses search, `j` and `k` move through events, `Esc` closes the panel, ⌘K opens the command
    palette.
  - Export the current results as CSV or JSONL. <!-- source: packages/contracts/src/routes.ts (export ?format=csv|jsonl) -->
- **visual:** clip `marketing/captures/2026-11-07-site-console/investigate-explorer-operation.webm` (manifest id `investigate`: type a query, open an event,
  follow its operation).

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
  - Any field you send, however deeply nested, is searchable by its dotted path.
- **visual:** `marketing/captures/2026-11-07-site-console/query-suggestions-light.png` (manifest id `query-suggestions`) under the query-language code sample.

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
- **visual:** `marketing/captures/2026-11-07-site-console/sql-rejected-light.png` (manifest id `sql-rejected`: a subquery rejected before it runs).

## entity-pages

- **id:** `entities`
- **eyebrow:** Follow anything
- **heading:** A page for every actor, tenant, worker and record.
- **body:** Every actor, tenant, executor and record in your events gets its own page. Each one shows an activity
  chart, its top actions, its outcome split, related entities and a full timeline. Directory pages list them all,
  most active first, with fuzzy search.
  <!-- source: docs/SPEC.md §8 journey 5; docs/concepts.md -->
- **bullets:**
  - **Actors:** who caused it. Users, API keys, integrations, the system.
  - **Tenants:** whose account. "What happened at Azure Hotels last week?" is one click.
  - **Executors:** what did the work. The API, each queue worker and cron job, with job ids and attempts.
  - **Records:** what changed. `booking:bk_1042` has a history of its own.
- **visual:** `marketing/captures/2026-11-07-site-console/tenant-light.png` (manifest id `tenant`).

## operations

- **id:** `operations`
- **eyebrow:** Operation trees
- **heading:** One request, every job it started, as a single tree.
- **body:** Send the same `operationId` on a request and the jobs it starts. Add `parentEventId` to say which event
  caused which. Logbird draws the tree: each step with its outcome, executor and timing. A failed first attempt and
  the retry that worked sit side by side.
  <!-- source: docs/concepts.md §Operations; docs/SPEC.md §8 journey 6 -->
- **visual:** `marketing/captures/2026-11-07-site-console/operation-light.png` (manifest id `operation`: a scheduler request, its jobs, failed attempts and
  the retries that worked; the durations are fixture data).

## event-detail

- **id:** `event-detail`
- **eyebrow:** Event detail
- **heading:** The full story of one event.
- **body:** Open any event to read it as a sentence: who did what, in which account, to which records, and how it
  ended. The actor and the executor are on separate cards. When staff acted for a customer, the impersonator gets a
  card too.
- **bullets:**
  - Before and after values for every changed field.
  - The causation breadcrumb, with a link to the whole operation.
  - Context ids (request, trace, IP), every custom attribute, and the raw JSON exactly as received.
  - Copy a link, or copy the event as a curl command.
  <!-- source: docs/SPEC.md §8 journey 4 (event sheet) -->
- **visual:** `marketing/captures/2026-11-07-site-console/impersonation-light.png` (manifest id `impersonation`: the impersonator card).

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
- **body:** Send your first event and the setup page notices on its own. It then checks each part of your
  integration against your real events: actors, tenants, executors, targets, operation ids, retention and team
  invitations. For each gap it links to the events that are missing that field.
  <!-- source: docs/SPEC.md §8 journeys 2 and 10 -->
- **bullets:**
  - Onboarding picks up where you left off.
  - "Send a test event" and "Load sample data" to see the console before you integrate. Sample data is 2000
    fictional events over seven days. It never counts as setup, and you can remove it.
    <!-- source: docs/SPEC.md §5 sample-data -->
  - A conformance score on every event, and a Fields page that shows every field you send and how often.
- **visual:** `marketing/captures/2026-11-07-site-console/setup-light.png` (manifest id `setup`). The onboarding stills were discarded because the page's
  snippet prints the ingest key.

## retention

- **id:** `retention`
- **eyebrow:** Retention
- **heading:** Keep events exactly as long as you decide.
- **body:** Each project keeps events for a window you choose, from 7 days to 10 years. New projects start at 90
  days. A worker deletes expired events every hour. Before you lower the window, Logbird shows how many events will
  be deleted. To confirm, you type the project's slug, and the purge starts right away.
  <!-- source: docs/SPEC.md §1.4, §4, §5 retention preview, §6 (retentionDays=90), §7.1; packages/contracts/src/api.ts RETENTION_OPTIONS -->
- **limit line:** Retention deletes are permanent. There's no archive and no undo. The preview count is
  approximate, because storage is at least once.
- **visual:** `marketing/captures/2026-11-07-site-console/retention-light.png` (manifest id `retention`: the 30-day preview; nothing was confirmed).

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
  role on every request, not just the UI.
  <!-- source: docs/SPEC.md §7, §7.1; SECURITY.md -->
- **limit line:** SSO isn't available yet. It's on the roadmap.
- **visual:** none (a compact card on the page).

## read-api

- **id:** `read-api`
- **eyebrow:** Read API
- **heading:** Show history inside your own product.
- **body:** Give your customers a "History" tab. Your backend calls `GET /v1/events` with a read key and a query
  such as `target:bk_1042 tenant:biz_7`, then returns the page to your UI. Results are paginated with a cursor. The
  Vue, Nuxt and TanStack Start packages include helpers for this.
  <!-- source: packages/contracts/src/routes.ts, api.ts; docs/integrations.md -->
- **limit line:** A read key can read the whole project. Your backend must check that the person asking may see
  that tenant or record, on every page it fetches. <!-- source: docs/integrations.md §Design -->
- **cta:** Read API on the developer page → `/developers#read-api`
- **visual:** code sample (see `developers.md` § read-api)

## roadmap

- **id:** `roadmap`
- **eyebrow:** On the roadmap
- **heading:** What we plan to build next.
- **body:** These are plans, not features. Order and timing can change.
- **bullets:** <!-- source: docs/roadmap.md P1, P2 -->
  - Tenant-scoped read tokens, so a browser can read one customer's history without a project-wide key.
  - Per-project redaction rules, applied before events are stored.
  - Alert rules on chosen actions, by email or webhook.
  - Webhooks and streaming export for SIEM and long-term archives.
  - Per-tenant export on the read API.
  - SSO (OIDC) for the console.
- **visual:** none
