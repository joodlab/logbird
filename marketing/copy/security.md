---
title: Security and data handling — Logbird
description: How Logbird isolates projects, stores keys, guards SQL, deletes expired data and audits itself, and what we don't claim yet.
path: /security
---

# Security and data handling

## intro

- **id:** `intro`
- **eyebrow:** Security
- **heading (H1):** How Logbird handles your data.
- **body:** An audit log holds sensitive history, so this page says what Logbird does with it and where each
  protection stops. The repository's `SECURITY.md` and `docs/SPEC.md` have the details.
- **visual:** an "On this page" list linking to each section below.

## self-host

- **id:** `self-host`
- **eyebrow:** Where data lives
- **heading:** Self-hosted, your events stay on your servers.
- **body:** When you self-host, events are stored in your own ClickHouse, and workspaces, projects and keys in your
  own Postgres. The self-hosted software doesn't send usage data back to us. The one outside service it needs is the SMTP provider
  you choose, which delivers sign-in codes and invitations.
  <!-- source: docs/self-hosting.md; README.md §Architecture; no analytics/telemetry code found in apps/ or packages/ (grep, 2026-11-07) — owner to confirm -->
- **visual:** diagram: one box labelled "Your server" holding console, API, worker, Postgres, ClickHouse and Redis.
  The only arrow leaving the box goes to "Your SMTP provider", labelled "sign-in codes, invitations".
  Caption: "Self-hosted: the console, API, worker, Postgres, ClickHouse and Redis all run on your server. The only
  connection out goes to your SMTP provider, for sign-in codes and invitations."

## retention

- **id:** `retention`
- **eyebrow:** Retention
- **heading:** Expired events are permanently deleted.
- **bullets:**
  - Each project has a retention window, from 7 days to 10 years. New projects start at 90 days.
  - A worker deletes events older than the window every hour. Each run is recorded and shown in Settings.
  - Before you lower retention, Logbird shows roughly how many events it will delete. To confirm, you type the
    project's slug. The purge starts immediately.
  - Deleting a project deletes all of its events.
  - There's no archive and no undo.
  <!-- source: docs/SPEC.md §1.4, §4 (retention), §5 (preview), §6, §7.1; packages/contracts/src/api.ts RETENTION_OPTIONS -->
- **visual:** `marketing/captures/2026-11-04-ui-foundation/light-settings-retention-confirm.png` (the slug
  confirmation dialog). Re-capture first (see `README.md` § Captures).

## isolation

- **id:** `isolation`
- **eyebrow:** Projects and keys
- **heading:** Every key belongs to one project and does one job.
- **bullets:**
  - **Project-bound keys.** An API key works for exactly one project.
  - **Two kinds.** Ingest keys (`lb_ingest_...`) can only write. Read keys (`lb_read_...`) can only read.
  - **Stored hashed.** Logbird keeps a SHA-256 hash and a short display prefix. The full key is shown once, when you
    create it.
  - **Revocable.** Revoke a key in Settings; the console shows when each key was last used.
  - **Workspace boundaries.** The server checks on every request that the project belongs to your active workspace.
    A request for another workspace's project gets a 404 and reveals nothing about it.
  <!-- source: docs/SPEC.md §5, §6 (ApiKey lastUsedAt, revokedAt), §7.1; SECURITY.md -->
- **visual:** `marketing/captures/2026-11-05-final-walkthrough/11-api-keys.png`. Check that no full key is visible.

## sql-guard

- **id:** `sql-guard`
- **eyebrow:** SQL mode
- **heading:** SQL search that can only read your project.
- **body:** SQL mode accepts a single boolean `WHERE` expression. Four layers stand between it and other people's
  data.
- **steps:**
  1. **Checked against ClickHouse's own parse.** The server asks ClickHouse for the statement's syntax tree. It
     rejects anything that isn't exactly Logbird's own query with your condition in it.
  2. **Allowlisted.** Only known columns and a fixed list of functions may appear. Subqueries, `UNION`, `WITH`,
     `SETTINGS`, table functions, system tables, comments and semicolons are rejected.
  3. **A restricted user.** Queries run as a separate read-only ClickHouse user. It can only `SELECT`, and it has fixed
     ceilings on time, rows read, memory and result size.
  4. **Row policies.** Database row policies limit that user to the project you're authorized for. Even
     `1 OR 1` can't return another project's rows.
  <!-- source: docs/SPEC.md §5.1.2; docs/query-language.md §Security model -->
- **limit line (callout titled "Where these layers stop"):** These layers protect against a broadened or malformed filter. They don't replace the server's own
  authorization, and they don't protect against stolen database credentials. SQL mode is for the console only; the
  public API rejects it. <!-- source: docs/query-language.md §Security model -->
- **visual:** `marketing/captures/2026-11-05-final-walkthrough/qb-23-sql-rejected.png`. Re-capture first (see `README.md` § Captures).

## roles

- **id:** `roles`
- **eyebrow:** Roles
- **heading:** Permissions are checked by the server.
- **body:** Owners and admins manage projects, keys, retention and invitations. Members search, export, save views and
  read workspace activity. Any action that isn't explicitly allowed is denied, for every role. The UI hides what you
  can't do, but the API is what enforces it.
  <!-- source: SECURITY.md §Authorization threat notes; docs/SPEC.md §7.1 -->
- **bullets:**
  - Sign-in is by a one-time code sent by email. There are no passwords to leak.
  - Sign-in requests are rate-limited per client.
  <!-- source: docs/SPEC.md §7; docs/self-hosting.md (AUTH_RATE_LIMIT_PER_MINUTE) -->
- **visual:** none

## impersonation

- **id:** `impersonation`
- **eyebrow:** Impersonation
- **heading:** When staff act for a customer, both names are recorded.
- **body:** Send the staff member as `impersonator` and keep the customer as `actor`. The event detail shows both.
  Search `impersonator:*` to list every event done on someone's behalf.
  <!-- source: docs/concepts.md §Actors; docs/query-language.md -->
- **visual (site, until a clean capture exists):** a JSON event: action `room.rate.updated`, actor Lina Haddad
  (`lina@example.test`), impersonator Omar Saleh, tenant Azure Hotels, target Room 12. Title: "Support changes a rate
  for Lina". Caption: "Lina stays the actor. Omar, from support, is on the event as the impersonator."
  Capture to use later: `marketing/captures/2026-11-05-final-walkthrough/06-impersonation.png`. Re-capture first (see `README.md` § Captures).

## self-audit

- **id:** `self-audit`
- **eyebrow:** Workspace activity
- **heading:** Logbird audits its own management actions.
- **body:** Creating a project, creating or revoking a key, changing retention, inviting a member: each of these is
  recorded as an event in your workspace's activity stream. Every member can read it.
  <!-- source: docs/SPEC.md §1.5, §7.1 (workspace activity readable by members) -->
- **visual (site, until a clean capture exists):** four log rows: `project.created`, `api_key.created`,
  `api_key.revoked`, `project.retention.changed`. Caption: "Examples of management actions in the activity stream."
  Capture to use later: `marketing/captures/2026-11-04-ui-foundation/light-workspace-activity.png`. Re-capture first (see `README.md` § Captures).

## limits

- **id:** `limits`
- **eyebrow:** Rate limits and delivery
- **heading:** Bounded by design.
- **bullets:**
  - Each project has its own ingest and read rate limits, shared across replicas through Redis.
  - Failed authentication attempts are limited per client, so repeated bad keys are throttled. Valid keys keep
    working behind a shared network address.
  - If Redis fails, sign-in limits fail closed (requests are refused) and ingest and read limits fail open (requests
    continue).
  - Delivery is at least once. A retry can store an event twice, so counts may include duplicates.
  - Don't send secrets. The SDK's `redact()` helper replaces common secret fields before sending.
  <!-- source: docs/SPEC.md §5; docs/deployment.md; README.md; packages/sdk/README.md -->
- **visual:** none

## reporting

- **id:** `reporting`
- **eyebrow:** Responsible disclosure
- **heading:** Report a vulnerability privately.
- **body:** Please don't post details in a public issue. Email the security contact below. Include the affected
  version, a reproduction using fictional data, and the impact. We'll coordinate the fix and the disclosure with
  you. We don't offer a response-time SLA yet.
  <!-- site rule: the site names only the security email, never a GitHub reporting flow -->
  <!-- source: SECURITY.md -->
- **contact:** `security@logbird.dev` — **placeholder**. The domain isn't bought yet, and `SECURITY.md` has no
  contact address configured. The owner must set a real address before launch.
- **visual:** none

## dont-claim

- **id:** `dont-claim`
- **eyebrow:** What we don't claim
- **heading:** No certifications yet.
- **body:** Logbird doesn't hold SOC 2, ISO 27001 or any other certification today, and we don't claim that
  using it makes you compliant with any law or standard. Logbird can help you answer an auditor's questions:
  who did what, when, in which account, and what changed. The rest of the work is yours, and we'll say so plainly.
- **visual:** none
