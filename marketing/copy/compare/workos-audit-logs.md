---
title: Logbird and WorkOS Audit Logs compared
description: WorkOS Audit Logs is a hosted audit log API with an Admin Portal viewer and SIEM log streams. How it compares with Logbird, sourced.
path: /compare/workos-audit-logs
---

# Logbird and WorkOS Audit Logs

## summary

- **id:** `summary`
- **eyebrow:** Compare
- **heading (H1):** Logbird and WorkOS Audit Logs
- **body:** WorkOS Audit Logs is a hosted service for recording what users do in your product and handing that record
  to your enterprise customers. You define a schema for each action, send events to the WorkOS API, and your
  customers' IT admins can view and export them through the WorkOS Admin Portal. Events can also stream to Datadog,
  Splunk, S3, Google Cloud Storage, Microsoft Sentinel, Snowflake or any HTTPS endpoint. If your customers' IT
  teams expect to browse and export audit logs themselves, it covers that out of the box. [W1–W5]
- **visual:** none

## table

- **id:** `table`
- **heading:** At a glance
- **table:**

  | | Logbird | WorkOS Audit Logs |
  | --- | --- | --- |
  | Licence and source | MIT; source opens publicly soon | No source code or licence published [W1, W2] |
  | Self-host | Yes: Docker Compose or Coolify | No self-host option documented. The on-prem guide covers your app calling WorkOS's cloud. [W6] |
  | Hosting model | Self-hosted, MIT (source opens soon); Logbird Cloud waitlist | Hosted by WorkOS [W2] |
  | Schema | Any JSON with an `action`; nothing to register | Event schemas must be configured per action before you emit; metadata JSON Schema validation is optional [W2, W7, W8] |
  | Required event fields | `action` | `organization_id`, `action`, `occurred_at`, `actor`, `targets`, `context` [W9] |
  | Search | Query language and guarded SQL `WHERE` mode in the console | Filter by actors, events, targets and dates in the Dashboard and Admin Portal [W1, W2] |
  | Export | CSV or JSONL from the explorer | CSV export via API, one organization and date range at a time, covering the past three months [W10] |
  | Streaming to SIEM | On the roadmap | Log Streams to seven destination types [W5] |
  | Retention | Per project, 7 days to 10 years; can be lowered, with a preview and permanent deletion | Per organization; 30 days by default; can be raised up to 10 years; lowering isn't supported [W2, W11] |
  | Customer-facing viewer | None yet; read API plus headless Vue helpers | Admin Portal: view and export events [W3] |
  | Programmatic read | `GET /v1/events` with a project read key | Export API; Widgets GraphQL API to search one organization's events [W10, W12] |
  | Storage engine | ClickHouse for events, Postgres for metadata | Not disclosed |
  | Pricing | Self-host free (MIT); Cloud pricing not set | $0/month base; $125/month per SIEM connection; $99/month per million events stored (as of 2026-11-07) [W1, W13] |

- **visual:** none

## choose-them

- **id:** `choose-workos`
- **heading:** When to choose WorkOS Audit Logs
- **bullets:**
  - Your enterprise customers' **IT admins need to view and export their own audit logs** today, through a ready-made
    portal.
  - You need **log streams to a SIEM** (Datadog, Splunk, Sentinel, S3 and others) now.
  - You want **strongly typed events**, validated against a schema for each action.
  - You'd rather **not run any infrastructure**, and you already use WorkOS for other features.
- **visual:** none

## choose-us

- **id:** `choose-logbird`
- **heading:** When to choose Logbird
- **bullets:**
  - Your audit data must **stay on your own servers**, or you want to read and change the code.
  - You want to **start sending without defining schemas first**, and add fields over time.
  - Your team needs an **operator console**: search with a query language or SQL, entity pages, operation trees,
    workers and retries.
  - You need to **lower retention**, not only raise it, and see what will be deleted before it happens.
- **cta:** Self-host Logbird → `/self-hosting` · Join the waitlist → `/contact`
- **visual:** none

## sources

- **id:** `sources`
- **heading:** Sources (all accessed 2026-11-07)
- **list:**
  - W1 — Product page: "Advanced event logging, auditing, and exporting for IT admins"; filtering; pricing lines.
    https://workos.com/audit-logs
  - W2 — Docs overview: event structure, schemas required before emitting, Dashboard viewing, retention defaults.
    https://workos.com/docs/audit-logs
  - W3 — Admin Portal: "Users will be able to view and export Audit Log events…".
    https://workos.com/docs/audit-logs/admin-portal
  - W4 — Platform Audit Logs (optional WorkOS-emitted events). https://workos.com/docs/audit-logs/platform-audit-logs
  - W5 — Log Streams: Datadog, Splunk, AWS S3, Google Cloud Storage, Microsoft Sentinel, Snowflake, Generic HTTPS.
    https://workos.com/docs/audit-logs/log-streams
  - W6 — On-prem deployment guide. https://workos.com/docs/on-prem-deployment
  - W7 — Create schema API. https://workos.com/docs/reference/audit-logs/schema/create
  - W8 — Metadata schema: optional validation. https://workos.com/docs/audit-logs/metadata-schema
  - W9 — Create event API: required fields. https://workos.com/docs/reference/audit-logs/event/create
  - W10 — Exporting events: single organization, date range, past three months.
    https://workos.com/docs/audit-logs/exporting-events · https://workos.com/docs/reference/audit-logs/export
  - W11 — Set retention API: `1_MONTH` to `11_MONTHS`, `1_YEAR` to `10_YEARS`.
    https://workos.com/docs/reference/audit-logs/retention/set
  - W12 — Widgets API, audit events (GraphQL). https://workos.com/docs/widgets-api/audit-logs/audit-events.md
  - W13 — Pricing page, Audit Logs section. https://workos.com/pricing
- **unverified (left out of the table):** whether `context.location`, `context.user_agent` and actor or target
  sub-fields are each required; how the per-million-events charge relates to the 30-day default; event size and rate
  limits; Admin Portal link expiry and filter options; whether the Widgets GraphQL API is generally available; storage
  engine and data-residency options.
- **visual:** none
