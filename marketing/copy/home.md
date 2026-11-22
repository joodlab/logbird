---
path: /
module: apps/web/src/content/home.ts
---

# Home: brief

**The words live in the module.** The page renders `apps/web/src/content/home.ts`. The shared calls to action, the header's
GitHub link and the closing band render `apps/web/src/content/shared.ts`, and the illustration renders
`apps/web/src/content/illustration.ts`. This file holds what the module can't: the job of each section, the proof behind
every claim, the visuals and the owner notes. It doesn't restate page text. To change wording, edit the module and check
the claim against the sources below in the same pull request. `apps/web/src/content/content-modules.test.ts` fails if
prose comes back into the route file.

## The page's job

Home sells the two jobs people pay for, in this order:

1. **Customer-facing audit logs.** A B2B product's customers ask to see who did what in their account.
2. **Compliance evidence.** An auditor, or a customer's security team, asks what happened and wants something to keep.

Support investigations come third, as the everyday use. Then the page answers the developer (one call per action) and
the buyer's last question (self-host or Cloud), and it ends with the limits. Every claim is true for master, or for the
release named next to it. Nothing gated (see `README.md` § Owner-gated copy) appears.

**Promise:** give your customers an audit log they can see, and your auditors an export they can check: one event per
action, searchable in the console, self-hosted today or hosted by us in early access. The hero carries it (H1 plus lead).
"Retrace every step." is the brand line: it is the hero eyebrow, near the wordmark, and the closing band's eyebrow. It is
not the H1.

## Numbers

Every number on the page is measured and sourced, or absent. `searchLatency` in the module stays empty until T1 sends a
measured ingest-to-search time with its date and hardware. Until then the page says "searchable in the console" and gives
no time.

## State variants

The module is a function of `SiteState` (`content/site.ts`). `ByRepo` and `ByCloud` need both variants, so a missing
one fails `tsc`.

| State | What changes | Module keys |
| --- | --- | --- |
| Repository private | The hero lead and self-host card say "once the source opens"; the description, Cloud card and footer never call the source open-source; the status line has the "coming soon" prefix; no GitHub links; the .NET line names the folder without a link; the self-host CTA leads to the waitlist | `hero.lead`, `hero.status`, `hero.github`, `hosting.selfHost.body`, `developers.otherStacks`, `shared.selfHostCta`, `shared.githubNav`, `homeMetaFor` |
| Cloud open (`WEB_APP_URL`) | The primary CTA asks for access; the lead and the Cloud card say early access; a sign-in link appears | `shared.accessCta`, `hero.lead`, `hero.signIn`, `hosting.cloud.body`, `homeMetaFor` |
| Scoped read access proven on production (`SCOPED_READ_LIVE`) | Job 1 swaps "read through your backend" for viewer tokens and scoped keys, each state with its own limit | `customers.now`, `customers.scoped` |

`SCOPED_READ_LIVE` in `content/site.ts` stays `false` until the maintainer confirms the production proof (#138). Then
it flips in one change. The test renders the current state and checks the other one.

## Sections, in order

| Section (module key) | Job | Visual |
| --- | --- | --- |
| `hero` | The promise: the two jobs, how events get in, where it runs | The `LogStack` illustration and the curl sample |
| `explorer` | Show the console, not describe it | `marketing/media/staydesk/explorer-light.webp` (dark pair `explorer-dark.webp`) |
| `customers` | Job 1: show each customer account its own history, with the limit as its own visible line | `marketing/media/staydesk/tenant-light.webp` |
| `evidence` | Job 2: what you can show an auditor, each row with where it ends | `marketing/media/staydesk/retention-light.webp` and the limits table |
| `operators` | Support investigations: one search, entity pages, operation trees | `marketing/media/staydesk/event-sheet-light.webp` |
| `developers` | One call per action; TypeScript tabs; one sentence for every other stack and .NET | The Route and Worker tabs |
| `hosting` | Self-host or Cloud, in the current state, with no prices | Two cards |
| `guarantees` | Delivery, SDK, validation, retention and import promises with their limits | Two-column table |
| closing band (`closing`, `shared.ctaBand`) | Start with one event; the brand line; the design-partner line | `LogStack` |

The envelope and how-it-works blocks moved off home. The envelope is on `/developers`. The architecture figure
(`content/architecture.ts`) is now on `/self-hosting`, in its requirements section.

## Proof

Every claim on the page, with its source. Update the source and the module together.

| Claim (module key) | Source |
| --- | --- |
| Search your events in the console, within the indexing limits (`hero.lead`) | `docs/SPEC.md` §3 (attribute indexing limits) and §5.1 |
| One event per action over HTTP or the TypeScript SDK; only `action` is required, and a missing recommended field never causes a rejection (a supplied one can still be rejected, for example an `id` over 256 trimmed UTF-16 units) (`hero.lead`, `hero.sample`, `developers.lead`, `guarantees.items[2]`) | `docs/SPEC.md` §1.1, §3; `packages/sdk/README.md`; `README.md` Quickstart |
| Export it complete (`hero.lead`, `evidence.rows[2]`) | `docs/exports.md` § Which format? (`jsonl-evidence`: the normalized event plus the stored original payload) |
| MIT-licensed; run it on your own servers (`hero.lead`, `hosting.selfHost`) | `LICENSE`; `docs/self-hosting.md` |
| Logbird Cloud: early access or waitlist, by state; the same codebase; "we run" the servers, upgrades and backups only once it is open, "we will run" before (`hero.lead`, `hosting.cloud`) | `content/shared.ts` (Cloud CTA rule, `README.md`); `marketing/copy/cloud.md` hero |
| Send `tenant`, and each account can see its own trail (`customers.lead`) | `docs/concepts.md` § Tenants |
| A read key plus the query language, for example `tenant:biz_7` (`customers.now.points[0]`) | `docs/SPEC.md` §5 (read keys) and §5.1 (query language) |
| The Nuxt proxy denies by default; `authorize()` returns the only forwarded query (`customers.now.points[1]`) | `docs/integrations.md` § Design |
| `useAuditTrail` loads pages (`loadMore`); headless `AuditTimeline` (`customers.now.points[2]`) | `docs/integrations.md` § Design |
| A read key reads the whole project, so your backend authorizes (`customers.now.limit`) | `docs/integrations.md` § Design ("A project read key is project-wide; a query filter is not authorization.") |
| After the proof: viewer tokens of 15 minutes by default, one hour at most; the scope applied outside every query on search, detail, counts and export; scoped keys with optional target and action prefixes; one tenant per scope, stored ids, ClickHouse enforcement only with the restricted query user (`customers.scoped`) | `docs/scoped-read-access.md`; `CHANGELOG.md` 0.2.0 (release branch) § Scoped read access |
| Actor, `impersonator`, tenant, records, before and after for up to 256 changes (`evidence.rows[0]`, `operators.screenshot`) | `docs/concepts.md` § Actors; `packages/clickhouse/src/normalize.ts` (`e.changes.slice(0, 256)`: the first 256 are kept, with their before and after values) |
| Logbird records what your code sends (`evidence.rows[0].limit`) | `docs/SPEC.md` §1 item 2 ("Capture is the client's job") |
| Retention from 7 days to 10 years; hourly deletion (`evidence.rows[1]`, `guarantees.items[3]`) | `packages/contracts/src/api.ts` `RETENTION_OPTIONS`; `docs/SPEC.md` §1.4, §4 |
| An owner or admin can shorten retention at any time; the deletion starts right away (`evidence.rows[1].limit`, from `content/evidence-limits.ts`, shared with the compliance page) | `docs/SPEC.md` §1 item 4 and §7.1 (PATCH `retentionDays`: owner, admin); `/security` § Retention |
| No retention lock or legal hold yet (`evidence.rows[1].limit`) | No such feature in the code; issue #141 is an open proposal, not on `docs/roadmap.md`, so the page makes no roadmap claim |
| When the export completes, its record keeps the filter, fixed query clock, SHA-256, size and row count; the limit sentence (`evidence.rows[2]`, from `content/evidence-limits.ts`, shared with the compliance page: what a match shows, and that it doesn't show the events were unchanged before the export ran) | `docs/exports.md` (opening paragraph; § File-to-record verification, whose last sentence the limit follows; § Audit lifecycle: an `export.outcome_unknown` record has no digest, hence "when the export completes") |
| Workspace activity: project and retention changes, keys, members and roles, saved views, invite links, exports, sign-ins, sign-outs and revoked sessions (not sessions that simply expire); it doesn't record reads (`evidence.rows[3]`) | `docs/workspace-audit.md` § Activity action catalogue (no search or view action is listed) |
| Search syntax and guarded SQL, entity pages, operation trees (`operators.features`) | `docs/SPEC.md` §5.1; `docs/concepts.md` |
| SDK, middleware, `jobAudit`, the conformance score (`developers.items`, `developers.code`) | `packages/sdk/README.md`; `docs/integrations.md`; `docs/SPEC.md` §3 (`conformance`); `packages/clickhouse/src/normalize.ts` |
| Any language that can POST JSON works; a .NET package is in the repository, not on NuGet (`developers.otherStacks`) | `docs/SPEC.md` §5 (`POST /v1/events`); `sdks/dotnet/README.md`; `CHANGELOG.md` on the `chore/release-0.2.0` branch, 0.2.0 § .NET; NuGet has no `Logbird` or `Logbird.AspNetCore` package (checked 2026-11-22) |
| The guarantees table (`guarantees`) | `docs/SPEC.md` §2 (including `Logbird-Retry: subset`: only the unsettled events are resent when a `503` lists them), §3; `docs/concepts.md`; `packages/sdk/README.md`; `docs/integrations.md` § Outage backpressure (per-event validation; the bounded SDK queue and its drop policy) |

## Owner notes

- **Wording near the export digest.** Never "verify integrity", "tamper", "proof" or "certified" near the SHA-256 line.
  The comparison pages' "Tamper evidence: None" stays.
- **.NET.** No C# code and no install command until the maintainer confirms the packages are on NuGet.
- **Prices.** None, until the owner approves the pricing proposal.
- **Design partner.** The design-partner line (`closing.note`, from `lib/copy-flags.ts`) never names the partner.
- **Stars.** The GitHub links show no star count: it's a number with no measurement date.
