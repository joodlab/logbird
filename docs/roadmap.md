# Roadmap

Updated 2026-11-05. The next phase makes Logbird the audit log of **JoodCMS** (see
[joodcms-integration.md](joodcms-integration.md) for the event catalogue, architecture and rollout). Items are kept
only when JoodCMS's code shows the need. Product decisions stay fixed: any event shape, capture is the client's job, no
backfill, per-project retention with permanent deletion, console for operators, products read through the read API,
no free-form SQL in the cloud service.

Sizes: **S** ≤ 1 day, **M** 2–4 days, **L** 1–2 weeks.

## P0 — blocks JoodCMS staging

| # | Item | Why (evidence in JoodCMS) | Size | Status |
| --- | --- | --- | --- | --- |
| P0-1 | **Host-context SDK:** resolve actor/tenant/executor/ip lazily per `audit()` call; host-supplied `requestId`/`operationId`; `audit()` returns the event id; client `enabled`, `defaults` (environment), `beforeSend` + `redact()`; `jobAudit()` and `audit.carrier()` for workers | Auth is per route (`createRouteConfig({ guard: [isAuthenticated…] })`), so a global middleware sees no user; evlog owns `requestId` (`apps/server/src/server.ts:59-61`); guest PII in ~15 models; ~80 BullMQ job types (`apps/worker/src/processors.ts`) | M | PR #43 |
| P0-2 | **Per-project public rate limits:** budgets per project and key kind; the per-peer limit counts only failed authentication; `RateLimit-*` headers | 4–6 API + 4 worker pods behind one egress (`k8s/values/production.yaml:26-27`), each flushing every 1 s, against 600 req/min per peer per route (`apps/server/src/rate-limit.ts`) | S | PR #42 |
| P0-3 | **Distribution** of `@logbird/sdk` and `@logbird/hono` to JoodCMS: npm publish or a vendored copy | JoodCMS installs only from public npm (`.npmrc` empty, `minimumReleaseAge`), builds Docker images with `turbo prune --frozen-lockfile` | S | Owner decision D1, after the naming work lands |
| P0-4 | **JoodCMS starter kit:** client, middleware, typed catalogue, redaction, worker helper, history route, as a patch for owner approval | ~596 mutating endpoints need one consistent helper | S | PR #41 (`docs/joodcms-starter/`) |

Nothing else blocks staging: `GET /v1/events` already filters by `target:`/`tenant:`, paginates by cursor and accepts
any range, and Jood staff can open the console's record, tenant and actor pages from JoodCMS admin links.

## P1 — first production ("on" and customer-facing history)

| # | Item | Why | Size |
| --- | --- | --- | --- |
| P1-1 | **Tenant-scoped read tokens:** `POST /v1/tokens` (read key) mints a short-lived token bound to a server-enforced filter (tenant, optional targets) and a field mask (drop impersonator, ip, user agent, emails); `/v1/events` accepts it and ANDs the filter. Contracts change | Customer history in `apps/app` spans per-business RBAC with website and hotel scopes (`BusinessMembershipWebsiteScope`, `BusinessMembershipHotelScope`); a project-wide key in an API with ~596 mutating routes is too large a blast radius | M |
| P1-2 | **Ingest redaction rules per project:** settings list of attribute paths, change fields and key patterns, replaced with `[redacted]` before storage (attributes, changes and payload); console editor | 550+ handwritten call sites make an accidental guest email or token likely; client-side `redact()` is only one line of defence | M |
| P1-3 | **History read performance:** benchmark `target:`/`tenant:` history over 365 days at 1M events/day with fictional data; add `total=false` (skip the second count scan) for widgets; add a target-ordered projection only if p95 > 300 ms | Each `searchEvents` runs the match twice (rows, then count) (`packages/clickhouse/src/queries.ts:135-162`); JoodCMS history sheets page constantly | S–M |
| P1-4 | **Hono read proxy helper** with `authorize(c, query) => SearchQuery \| false` and response projection, matching the Nuxt proxy's deny-by-default model | JoodCMS API is Hono; history routes should be safe by default | S |
| P1-5 | **Published SLOs and limits; ingest-silence signal:** document ingest ack p99, availability, payload/batch/rate limits; per-project `lastEventAt`/accepted/rejected counters on `/v1` (or a health endpoint) so JoodCMS's HyperDX can alert when audit traffic stops | Production shadow exit criteria need numbers; a broken deploy that stops auditing must page someone | S |

## P2 — later

| # | Item | Why | Size |
| --- | --- | --- | --- |
| P2-1 | **Alert rules on actions** (email/webhook) for e.g. `admin.impersonation.started`, `api_key.created`, `website.purged`, `admin.seed.run` in production | Today these are invisible to Jood staff in real time; `admin/dashboard POST /seed` exists in the API | M |
| P2-2 | **Webhooks / streaming export** (signed HTTP push or S3/R2 JSONL) for SIEM and long-term archive | Compliance archive beyond retention | L |
| P2-3 | **Per-tenant export on the read API** (scoped token + JSONL/CSV stream) | Enterprise customers asking for their own audit trail | M |
| P2-4 | **Action schema hints:** upload a catalogue (action → expected targets/fields); conformance per action; Fields page shows drift | JoodCMS ships a typed catalogue; drift detection at 550 call sites | M |
| P2-5 | **SSO (OIDC)** for the console | Email OTP is fine for Jood's team size today | L |
| P2-6 | **Data-subject erasure** (purge events by actor/target id) | Only needed if D4 allows end-customer PII; the catalogue avoids it | M |

## Decisions needed from the owner

- **D1 Distribution:** publish `@logbird/*` to npm (after the rename) or vendor them into JoodCMS for staging?
- **D2 Hosting:** JoodCMS on Logbird cloud, or the self-hosted build on JoodCMS's k3s cluster (private network)?
- **D3 Tenant:** business (with website fallback), as proposed, versus website as the evlog enricher does today.
- **D4 Retention and PII:** production retention (proposal 365 days) and whether staff email + IP may be kept for it.
- **D5 Delivery guarantee:** in-memory SDK queue (≤ ~1 s loss on hard kill), or a BullMQ outbox for wave 1?
- **D6 Theme drafts:** skip editor autosaves (proposal) or record them?
- **P1 order:** confirm P1-1 → P1-2 → P1-3 → P1-4 → P1-5, and whether customer history (phase 2) is in scope for
  first production or follows it.

## Done (PRs #1–#40)

Ingest of any event shape, explorer, Actors/Tenants/Workers/Records pages, setup and onboarding, invites and invite
links, Lucene-style search and allowlisted SQL WHERE mode, per-project retention, role checks, the TypeScript SDK and
Hono/TanStack Start/Vue/Nuxt integrations, two rounds of QA fixes.
