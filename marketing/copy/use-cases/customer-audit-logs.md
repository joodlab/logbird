---
path: /use-cases/customer-audit-logs
module: apps/web/src/content/use-cases/customer-audit-logs.ts
---

# Customer-facing audit logs: brief

**The words live in the module.** The page renders `apps/web/src/content/use-cases/customer-audit-logs.ts` through the
shared use-case layout (`components/marketing/use-case.tsx`), the same as the compliance evidence page. This file holds
the page's job and the proof behind every claim.

## The page's job

The first paid job in depth: a B2B product whose customers' admins ask to see who did what in their account. The first
screen makes clear that the history appears inside *your* product, through *your* backend. The steps:
1. send `tenant` with each event;
2. understand the read-key limit, which comes before the how-to, as its own section;
3. authorize every read;
4. render it with your own components.

The landing page's customer section links here.

## Gated (maintainer)

Scoped read keys and viewer tokens are shown since 2026-11-23 (`SCOPED_READ_LIVE`, production proof 31/31, #138). The page
still leads with reading through your own backend; scoped access is the last section, and `use-cases.test.ts` checks
that it appears exactly when the flag is on.

## Proof

| Claim (section) | Source |
| --- | --- |
| `tenant` names the account an event belongs to; only `action` is required (`send`) | `docs/concepts.md` § Tenants; `docs/SPEC.md` §1.1 |
| Logbird can't infer the account of an event without `tenant` (`send` limit) | `docs/SPEC.md` §1 item 2 ("Capture is the client's job") |
| A read key reads the whole project; a query filter is not authorization; authorize on every request, including each next page (`before`) | `docs/integrations.md` § Design; `/developers` § Read API limit |
| Keys stay on the server, never in a browser bundle or public configuration (`before`) | `docs/integrations.md` § Design ("Never put an ingest or read key in public runtime config, client components or browser bundles") |
| Never trust the browser's tenant or query (`before`) | `packages/integrations/vue/README.md` ("Never trust a browser's tenant or q as authorization") |
| The Nuxt history route denies by default; only the query `authorize()` returns is forwarded (`read`) | `packages/integrations/nuxt/README.md`; `docs/integrations.md` § Design |
| The `authorize()` sample checks the session, ignores the browser's filter and returns `trailQuery({ tenant, cursor })`, typed `satisfies LogbirdHooks`; `nuxt.config.ts` registers it as `logbird.hooks`; the read key comes from `NUXT_LOGBIRD_READ_KEY` (`read`) | `packages/sdk/src/read.ts` (`trailQuery` quotes the tenant with `quoteQueryValue`); `packages/integrations/nuxt/src/index.ts` (`LogbirdHooks`, `hooks` option, private `runtimeConfig.logbird`); `packages/integrations/nuxt/src/runtime/proxy.ts` (only the returned query is forwarded); `examples/nuxt/nuxt.config.ts`; `packages/integrations/nuxt/README.md` |
| TanStack Start: `readAuditTrail` with `trailQuery`; any backend: the read API with the read key (`read`) | `packages/integrations/tanstack-start/README.md`; `docs/SPEC.md` §5 (read keys) |
| `useAuditTrail` pages, has loading/error/refresh/load-more, discards stale responses; `AuditTimeline` is headless (`render`) | `packages/integrations/vue/README.md`; `docs/integrations.md` § Design |
| In Nuxt, `useAuditTrail` reads through the module's authorized route; the sample destructures `data`, `error`, `nextCursor`, `loadMore` (`render` sample) | `packages/integrations/nuxt/README.md` ("Auto-imported `useAuditTrail(...)` uses the server route `/api/_logbird/events`") |
| Once `SCOPED_READ_LIVE` is on, a last section adds scoped keys and viewer tokens with the landing page's points and limit (`scoped`, from `homeContent(site).customers.scoped`) | `marketing/copy/home.md` (the `customers.scoped` row and its sources: `docs/scoped-read-access.md`, `docs/security.md` § Two enforcement layers, `CHANGELOG.md` 0.2.0) |
| The tenant-page visual: events in 24 hours and in all, and the support agents who acted while signed in as the customer (`render`) | The reviewed `tenant` capture (`marketing/media/staydesk/tenant-light.webp`), cropped |

## Visual

`tenant-account`: a crop of the reviewed `tenant` capture (header, counts and "who did it"). It opens full size on tap
(the layout's `zoom`), because console detail is too small to read at phone width. The caption says it's your team's
view in the console, not what your customers see.
