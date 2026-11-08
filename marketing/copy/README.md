---
title: Logbird website copy — index and messaging
description: Source of truth for the Logbird marketing site copy. Messaging hierarchy, proof points, glossary and word list.
path: (not a page)
---

# Logbird website copy

This folder is the copy source of truth for the marketing site (`apps/web`, TanStack Start, prerendered). Engineering
and design build pages from these files; wording changes happen here first.

Facts come from the repository only (each number has a `<!-- source: path -->` comment). Competitor facts come from
sourced web research dated 2026-11-07 (see `compare/`). The voice follows `docs/brand.md` §2.

## Files

| File | Page | Path |
| --- | --- | --- |
| [`home.md`](home.md) | Home | `/` |
| [`product.md`](product.md) | Product tour | `/product` |
| [`developers.md`](developers.md) | Developers | `/developers` |
| [`self-hosting.md`](self-hosting.md) | Self-hosting | `/self-hosting` |
| [`cloud.md`](cloud.md) | Cloud and pricing | `/cloud` |
| [`open-source.md`](open-source.md) | Open source | `/open-source` |
| [`security.md`](security.md) | Security and data handling | `/security` |
| [`compare/README.md`](compare/README.md) | Compare (index) | `/compare` |
| [`compare/retraced.md`](compare/retraced.md) | Logbird and Retraced | `/compare/retraced` |
| [`compare/workos-audit-logs.md`](compare/workos-audit-logs.md) | Logbird and WorkOS Audit Logs | `/compare/workos-audit-logs` |
| [`compare/pangea.md`](compare/pangea.md) | Logbird and Pangea Secure Audit Log | `/compare/pangea` |
| [`compare/bemi.md`](compare/bemi.md) | Logbird and Bemi | `/compare/bemi` |
| [`about.md`](about.md) | About | `/about` |
| [`contact.md`](contact.md) | Contact and waitlist | `/contact` |
| [`changelog.md`](changelog.md) | Changelog and build log | `/changelog` |
| [`blog.md`](blog.md) | Blog index and launch post draft | `/blog`, `/blog/why-were-building-logbird` |
| [`legal-privacy.md`](legal-privacy.md) | Privacy (placeholder) | `/legal/privacy` |
| [`legal-terms.md`](legal-terms.md) | Terms (placeholder) | `/legal/terms` |
| [`404.md`](404.md) | Not found | `*` |
| [`arabic-notes.md`](arabic-notes.md) | Notes on Arabic and bilingual moments | (not a page) |

### How each page file is laid out

Front matter: `title` (page `<title>`), `description` (meta description, 155 characters or fewer) and `path`.
Then one `##` block per section, in page order:

- `id`: the section anchor.
- `eyebrow`: optional small label above the heading.
- `heading`: the section heading. On a page's first section it is the H1.
- `body`, `bullets`: the copy.
- `cta`: label → target.
- `visual`: an exact path under `marketing/captures/`, or "code sample", or "diagram: …".

## Messaging hierarchy

### Tagline

**Retrace every step.** · **تتبّع كل خطوة.** <!-- source: docs/brand.md §2 -->

### One-line positioning

Logbird is the open-source audit log for your product. Send who-did-what events over HTTP or the SDK, search them, and
run it on your own servers. <!-- source: docs/brand.md §2 (cloud clause "or ours" held back until Logbird Cloud accepts sign-ups) -->

### Three pillars

1. **Send any shape.** Any JSON object with an `action` is a valid event. Logbird recommends an envelope (actor,
   tenant, executor, targets, changes, operation) and scores how much of it each event fills. It never drops an event
   for being off-standard.
   <!-- source: docs/SPEC.md §1.1, §3 -->
2. **Answer "who did what" fast.** Search with a query language or a guarded SQL `WHERE` expression. Follow any
   actor, tenant, worker or record on its own page. Open one request and every job it spawned as a single tree.
   <!-- source: docs/SPEC.md §5.1, §8; docs/concepts.md -->
3. **Own it, and know its limits.** MIT-licensed, self-hosted with Docker Compose, stored in ClickHouse. The
   guarantees are written down: a `202` means the event is in ClickHouse, delivery is at least once, and retention
   deletes are permanent.
   <!-- source: LICENSE; docs/self-hosting.md; docs/SPEC.md §1, §2; README.md -->

### Audiences

- **Product engineers** who owe their customers an audit trail: they want one call per action and no schema
  migration.
- **Operators, support and compliance staff** who must answer "what happened in this account?": they want search,
  entity pages and retention they can explain.

### Proof points (every one has a source)

| Claim | Source |
| --- | --- |
| MIT licence | `LICENSE` |
| Only `action` is required; nothing is rejected for missing recommended fields | `docs/SPEC.md` §1, `README.md` |
| The server answers `202` only after ClickHouse has the rows (`async_insert=1, wait_for_async_insert=1`) | `docs/SPEC.md` §2 |
| Delivery is at least once; counts may include duplicates | `README.md` |
| Retention permanently deletes expired events; lowering it requires typing the project slug and purges immediately | `docs/SPEC.md` §1, §7.1 |
| Retention options run from 7 days to 10 years (7, 14, 30, 60, 90, 180, 365, 730, 1825, 3650 days); new projects default to 90 days | `packages/contracts/src/api.ts` (`RETENTION_OPTIONS`), `docs/SPEC.md` §6 |
| One ingest request carries up to 1000 events or 5 MB; one event up to 256 KB | `docs/SPEC.md` §5, `packages/sdk/README.md` |
| Default per-project limits: 3000 ingest and 1200 read requests a minute, configurable | `docs/SPEC.md` §5 |
| API keys are project-bound, of kind ingest or read, stored as a SHA-256 hash, shown once | `docs/SPEC.md` §5 |
| SQL mode runs as a separate read-only ClickHouse user with row policies bound to one project | `docs/SPEC.md` §5.1.2, `docs/query-language.md` |
| Logbird records its own management actions in a workspace activity stream | `docs/SPEC.md` §1.5 |
| First-party integrations: Hono, TanStack Start, Vue, Nuxt; worker helper `jobAudit` | `docs/integrations.md`, `packages/sdk/README.md` |
| Self-host: sequential `docker compose build`, then `docker compose up -d --no-build`, Compose ≥ 2.24.4; Coolify; external Postgres/ClickHouse/Redis or Dragonfly; Caddy TLS | `docs/self-hosting.md`, `docs/coolify.md` |
| Suggested starting VM: 4 vCPU, 8 GB RAM, SSD — an initial allocation, not measured capacity | `docs/self-hosting.md` §Sizing |

**Not used on purpose:** performance numbers of any kind (query latency, events per second, "300,000 events in
~60 ms", "1.8 s to first event"). None of them has a measurement report yet. A load-test report is planned; numbers
can be added when it lands, each with its source.

## Self-host CTA rule

Nobody outside the team can self-host until the repository is public (no published images, no npm packages). While
`WEB_GITHUB_PUBLIC` is false the site must not offer a clone/compose quickstart or say "Self-host … today":

- Secondary CTA: **"Self-host when the source opens"** → `/contact?interest=self-host` (the waitlist, self-host preselected).
- Quickstart blocks become "Available when the repository opens." with the same link.
- "Self-host it" → `/self-hosting` and "Self-host today" return automatically once `WEB_GITHUB_PUBLIC=true`.

## Owner-gated copy

**Marker:** an owner-gated variant is written only inside an HTML comment that starts with `<!-- owner-gated: <topic>`.
Text inside those comments is never implemented on the site until the owner approves that topic; everything outside
them is safe to implement verbatim. Topics: `org-name` (the publisher's name, `WEB_ORG_NAME`), `origin-story`,
`design-partner-name`, `cloud-clause`.


These variants are **not** used anywhere on the site. The owner may approve them later.

- **Design partner:** the site says "Logbird is being integrated with a hotel-booking SaaS, our first design partner."
  Never say "in production" or "customer" until the rollout says so (`docs/roadmap.md`).
  <!-- Name design partners only after they approve publication. -->
- **Cloud clause in the positioning:** used only once Logbird Cloud accepts sign-ups.
  <!-- owner-gated: cloud-clause. "…and run it on your own servers or ours." (docs/brand.md) -->
- **Repository link:** comes from `WEB_GITHUB_URL`. Until the repository is public, every mention reads
  "Source on GitHub — coming soon".
  <!-- owner-gated: org-name. Repository: https://github.com/joodlab/logbird ; publisher: Joodlab -->

## Pending owner decisions that affect copy

- **Domain.** `logbird.dev` is **not bought yet**. Copy writes the domain as `logbird.dev`
  wherever one is needed, but nothing on the site may imply it is live before it is bought and configured. No mailbox
  is derived from it: contact addresses come only from `WEB_SECURITY_EMAIL` and `WEB_CONTACT_EMAIL`, with no default. The engineer should keep the domain in one config value.
- **Public repository timing.** All copy says "the repository opens publicly soon".
- **npm packages.** `@logbird/sdk` and the integrations are not on npm yet (registry returned 404 on 2026-11-07;
  `docs/roadmap.md` P0-3). Install lines are labelled "after the first npm release".
- **Docs links.** Pages link to repository docs (for example `docs/concepts.md`). Those links resolve once the
  repository is public or a docs site exists. Until then, the engineer can hide them or point them at `/developers`.
- **Security contact.** `SECURITY.md` still lists `SECURITY_CONTACT_EMAIL (not configured)`. The security page needs
  that address before launch.

## Captures

Pages use the console captures in `marketing/captures/2026-11-07-site-console/` (listed in
`apps/web/src/lib/media-manifest.ts`). They were shot against the real console in a fictional workspace,
"QA Azure Hotels", with a fictional user and seed data; see that folder's README for how.

- **No query timings:** the explorer's query timer was removed before each still, because the site makes no
  performance claims. Some shots still show durations that belong to the fictional data itself, such as an operation
  tree's "3.50 s" and step offsets. Those are seeded event timestamps, not measurements of Logbird.
- **Older captures:** the 2026-11-04/05/06 folders predate the rename or show older fictional demo workspaces. Don't
  use them on the site.
- **Replacing a capture:** keep its manifest id, or mark the entry `interim: true` while a replacement is pending. An
  interim entry blocks indexing and the Cloudflare build (`apps/web/src/lib/release.ts`).

## Glossary

Use these words the same way on every page. They match `docs/concepts.md`.

| Term | Meaning | Example |
| --- | --- | --- |
| **event** | One JSON object describing one action. Only `action` is required. | `{"action":"booking.cancelled"}` |
| **action** | Dot-namespaced name of what happened: `<entity>.<sub>.<verb>`. | `booking.cancelled`, `hotel.policy.updated` |
| **actor** | Who caused the action: a user, an API key, an integration, a service, or the system. | Lina Haddad (`usr_42`, user) |
| **executor** | What performed the action, and on which try: the API, a worker, a scheduler, a webhook. | Refunds worker, job `job_981`, attempt 2 |
| **impersonator** | Staff acting on a customer's behalf. The customer stays the actor. | Support agent `usr_1` |
| **tenant** | The customer account the action happened in. | Azure Hotels (`biz_7`) |
| **targets** | Every record the action touched, as `{ type, id, name }`. Shown on the **Records** pages. | `booking:bk_1042`, `payment:pay_77` |
| **changes** | Field-level before and after values. Never secrets: send `"[redacted]"`. | `status`: `confirmed` → `cancelled` |
| **operationId** | Groups one unit of work: a request, the jobs it spawned, their retries. | `op_cancel_bk_1042` |
| **parentEventId** | Links an event to the event that caused it. Builds the operation tree. | refund → cancellation |
| **conformance** | The share of recommended envelope fields an event fills. A hint, never a gate. | |
| **project** | One product or environment's event store, with its own keys and retention. | |
| **workspace** | Your team in the console. Holds projects and members. | |
| **ingest key / read key** | Project-bound API keys. Ingest keys only write; read keys only read. | `lb_ingest_...`, `lb_read_...` |
| **retention** | How many days a project keeps events. Older events are permanently deleted. | 90 days (default) |
| **workspace activity** | Logbird's own audit log of management actions in your workspace. | key created, retention changed |

## Words we use / words we avoid

| Use | Avoid |
| --- | --- |
| audit log, activity history, who did what | "observability platform", "SIEM" (Logbird is neither) |
| send, search, follow, keep, delete | leverage, unlock, supercharge, empower |
| "permanently deleted", "no archive, no undo" | "smart data lifecycle", "auto-archiving" |
| "at least once; counts may include duplicates" | "never lose an event", "exactly once", "100% reliable" |
| "a `202` means the event is in ClickHouse" | "real-time", "instant", any latency figure |
| self-host, self-hosted (adjective), on your own servers | on-prem (unless quoting someone) |
| open source, MIT-licensed | "free forever", "community edition" (there is one edition) |
| "Source on GitHub — coming soon" | any wording that implies the repository is public |
| "Logbird Cloud: join the waitlist" | "sign up", "start free trial", "get started free" |
| "being integrated with a hotel-booking SaaS" | "trusted by", "used in production by", customer counts |
| "helps you answer an auditor's question" | SOC 2, ISO 27001, HIPAA, "GDPR-compliant", "compliant" of any kind |
| guarded SQL `WHERE` expression | "full SQL access", "SQL console" |
| plain numbers with a source | seamless, blazing, effortless, AI-powered, revolutionize, enterprise-grade, best-in-class, exclamation marks |

Casing: "Logbird" in prose, `logbird` in code, commands and the wordmark, لوغبيرد in Arabic. Fictional data only:
Lina Haddad (`usr_42`), Azure Hotels (`biz_7`), booking `bk_1042`, emails at `@example.test`.
