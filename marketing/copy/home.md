---
path: /
module: apps/web/src/content/home.ts
---

# Home: brief

**The words live in the module.** The page renders `apps/web/src/content/home.ts`. The shared calls to action and the
closing band render `apps/web/src/content/shared.ts`, and the illustration renders `apps/web/src/content/illustration.ts`.
This file holds what the module can't: the job of each section, the proof behind every claim, the visuals and the owner
notes. It doesn't restate page text. To change wording, edit the module and check the claim against the sources below in
the same pull request. `apps/web/src/content/content-modules.test.ts` fails if prose comes back into the route file.

## The page's job

Home tells a product team what Logbird is in one screen, and then proves it to two readers in turn: the developer who
sends the events and the person who answers "what happened?" (support, operations, compliance). Every claim is true of
the product today. Nothing gated (see `README.md` § Owner-gated copy) appears here.

## State variants

The module is a function of `SiteState` (`content/site.ts`). `ByRepo` and `ByCloud` require both variants, so a missing
one fails `tsc`.

| State | What changes | Module keys |
| --- | --- | --- |
| Repository private | Status line prefixed "Source on GitHub — coming soon."; the self-host CTA leads to the waitlist; the open-source lead drops the images sentence; the third bullet; the quickstart becomes a waitlist panel | `hero.status`, `openSource.lead`, `openSource.bullets`, `openSource.quickstart`, `shared.selfHostCta`, `shared.ctaBand.body` |
| Cloud open (`WEB_APP_URL`) | Primary CTA asks for access; the status line says early access; a sign-in link appears | `shared.accessCta`, `shared.cloudStatusLine`, `hero.signIn`, `shared.ctaBand.body` |
| Release published | The quickstart title names the version and pulls its images | `openSource.quickstart.title`, `lib/selfhost.ts` |

## Sections, in order

| Section (module key) | Job | Visual |
| --- | --- | --- |
| `hero` | What it is, who it's for, how to start; the smallest valid event | `LogStack` illustration and the curl sample |
| `explorer` | Show the console, not describe it | `marketing/media/staydesk/explorer-light.webp` (dark pair `explorer-dark.webp`) |
| `developers` | One call per action, no schema; the SDK, middleware and worker story | Route and Worker code tabs |
| `operators` | The questions support and compliance get, answered in the console | `marketing/media/staydesk/event-sheet-light.webp` |
| `howItWorks` | Four steps from a key to a searchable history; the architecture | Steps and the architecture figure (matches `README.md` § Architecture) |
| `envelope` | The fields that make the console useful; only `action` is required | The annotated envelope |
| `openSource` | MIT, Docker Compose, your infrastructure | Quickstart commands, or the waitlist panel while private |
| `guarantees` | What Logbird promises and where each promise ends | Two-column table |
| closing band (`shared.ctaBand`, `closingNote`) | Start with one event; the design-partner line | `LogStack` |

## Proof

Every claim on the page, with its source in the repository. Update the source and the module together.

| Claim (module key) | Source |
| --- | --- |
| Only `action` is required; a missing recommended field never causes a rejection (a supplied field can still be rejected, for example an `id` over 256 trimmed UTF-16 units) (`hero.sample.caption`, `developers.lead`, `envelope.lead`, `guarantees.items[2]`) | `docs/SPEC.md` §1.1, §3 normalization rules (id limits) |
| The curl sample is a valid event (`hero.sample`) | `README.md` Quickstart; `docs/SPEC.md` §1.1 |
| Custom fields and `metadata` searchable as attributes within the indexing limits (`developers.lead`) | `docs/SPEC.md` §3 |
| SDK batching, retries, explicit flush and shutdown (`developers.items[0]`) | `packages/sdk/README.md` |
| Middleware for Hono, TanStack Start and Nuxt; Vue is a reader (`developers.items[1]`) | `docs/integrations.md` (Vue is `useAuditTrail`/`AuditTimeline`, not middleware) |
| `jobAudit` keeps the actor and joins the operation (`developers.items[2]`, `developers.code`, `developers.codeCaption`) | `packages/sdk/README.md` § Requests and workers |
| Conformance score: nine recommended checks; the setup page lists missing fields (`developers.items[3]`) | `docs/SPEC.md` §3 (`conformance`); `packages/clickhouse/src/normalize.ts`; the setup page's field list, `ENVELOPE_FIELDS` in `packages/contracts/src/setup.ts` |
| Before and after values for the first 256 changes per event (`operators.lead`, `operators.screenshot.caption`) | `packages/clickhouse/src/normalize.ts` (`e.changes.slice(0, 256)`: the first 256 are kept, with their before and after values) |
| Search syntax and guarded SQL `WHERE` (`operators.features.search`) | `docs/SPEC.md` §5.1 Query language (and its SQL mode) |
| Entity pages, operation trees, impersonation (`operators.features`) | `docs/concepts.md` (actors, tenants, executors, records, operations; `impersonator`) |
| Retention from 7 days to 10 years, permanent deletion (`operators.features.retention`, `guarantees.items[3]`) | `packages/contracts/src/api.ts` `RETENTION_OPTIONS` (7, 14, 30, 60, 90, 180, 365, 730, 1825, 3650 days); `docs/SPEC.md` §1.4, §4 |
| Ingest key shown once, stored as a hash (`howItWorks.steps[0]`) | `docs/SPEC.md` §5 |
| Up to 1000 events per request (`howItWorks.steps[1]`) | `docs/SPEC.md` §5 size limits |
| `202` with `ids` and `rejected` (`howItWorks.steps[2]`, `guarantees.items[0]`) | `docs/SPEC.md` §2 ingestion path |
| Expired events deleted every hour (`howItWorks.steps[3]`, `howItWorks.architecture`) | `docs/SPEC.md` §4 retention |
| The envelope example (`envelope.lines`) | `docs/concepts.md` worked example, event 1 (condensed) |
| One repository, MIT, Compose, Coolify, Caddy (`openSource`) | `LICENSE`; `docs/self-hosting.md` |
| The quickstart commands (`openSource.quickstart`) | `docs/self-hosting.md` § Five-minute quickstart, via `lib/selfhost.ts` |
| At-least-once delivery, exact retries stored once, `duplicate_id_conflict` (`guarantees.items[0]`) | `docs/SPEC.md` §2, §3; `docs/concepts.md` |
| The SDK queue is in memory (`guarantees.items[1]`) | `packages/sdk/README.md` |
| Per-event validation and `503` retry rules (`guarantees.items[2]`) | Per-event validation: `docs/integrations.md` § Outage backpressure (ingest paragraph). Retrying only the unsettled events when a `503` lists them: `docs/SPEC.md` §2 (`Logbird-Retry: subset`) |
| Imports with the original `occurredAt`, up to 3650 days back (`guarantees.items[4]`) | `docs/SPEC.md` §3 |

## Owner notes

- The design-partner line (`closingNote`, from `lib/copy-flags.ts`) never names the partner.
- The open-source visual (a terminal with `docker compose ps`) needs a new, reviewed capture before it ships. Check the
  terminal for paths or hostnames first.
- The landing-page rework (#250 step 2) replaces this page's structure around the two paid jobs: customer-facing audit
  logs and compliance evidence. Its brief replaces this one.
