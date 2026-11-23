---
path: /use-cases/support-investigations
module: apps/web/src/content/use-cases/support-investigations.ts
---

# Support investigations: brief

**The words live in the module.** The page renders `apps/web/src/content/use-cases/support-investigations.ts` through
the shared use-case layout (`components/marketing/use-case.tsx`), like the other use-case pages. This file holds the
page's job and the proof behind every claim.

## The page's job

The landing page's third section in depth: a customer asks support what happened in their account, and support or
operations answer from the events. The steps:
1. open the account or the record the customer names;
2. narrow it down in one search;
3. read one event in full;
4. follow its operation from the request to the jobs;
5. know what Logbird doesn't do, before the customer asks.

The landing page's support section links here.

## Rules

- No speed, size or "real-time" claim: none is measured for the console on production. A test rejects
  "instant", "real-time" and "millisecond".
- Each example query is one inline code span with no copy button, so what a reader copies is the query alone. The
  test compiles each one exactly as shown with the real query compiler, and fails if a code block appears on the page.
- No tamper, immutable or certified wording.

## Proof

| Claim (section) | Source |
| --- | --- |
| Jump to (Ctrl K): a name lists matching entities; an exact id is highlighted; a record is found by its bare id (`find`) | `CHANGELOG.md` 0.2.1 § Highlights and § Entity search; `apps/app/src/components/shell/command-palette.tsx` |
| Each account, actor, executor and record has a page with a timeline of every event that mentions it (`find`) | `docs/concepts.md` (opening paragraph and table) |
| When events name a support agent (`impersonator`), an account's page shows how many were done by support and lists up to six agents by name or id (`find`) | `apps/app/src/components/entities/support-split.tsx` (the `impersonator` facet, the agent list); `entity-profile.tsx`; the reviewed `tenant` capture |
| An account's page matches `tenant` id; a record's page matches the record in `targets`; search still finds an event with neither (`find` limit) | `apps/app/src/lib/entities.ts` (entity filters); `docs/query-language.md` |
| Exact matches, prefixes, ranges and `OR`; suggestions as you type, some values with counts from the rows checked; guarded SQL `WHERE` (`search`) | `docs/query-language.md` § Query language, § Autocomplete (counts from at most 50,000 recent rows), § Query bar (console), § SQL mode |
| The four example queries (`search`) | `docs/query-language.md` (`tenant:`, `outcome:`, `record:<type>:<id>`, presence `impersonator:*`, prefix `action:booking.*`, relative date `occurredAt:>now-7d`); compiled exactly as shown in `use-cases.test.ts` |
| With no matches: the id query for a bare id that matches an entity; otherwise "Search all time" when matches lie outside the range (`search` limit) | `CHANGELOG.md` 0.2.1 § Highlights; `apps/app/src/components/explorer/explorer.tsx` (empty state) |
| A cut-short count is a lower bound, shown as "≥ N" or "10,000+" (`search` limit) | `docs/SPEC.md` §4 hot-path rules (`totalExact: false`); `CHANGELOG.md` 0.2.0 § Search totals; maintainer ruling 2026-11-23 (lower bound OK) |
| The explorer capture: booking actions over seven days, matching events below the chart, true on desktop and phone (`search` visual) | The reviewed `explorer` captures (`marketing/media/staydesk/explorer-*.webp`, `phone-explorer-*.webp`) |
| The actor is the identity the action used; with impersonation the customer stays the actor and the staff member is the impersonator (`event`) | `docs/concepts.md` § Actors |
| The executor ran it, with the attempt number when sent; changes, the first 256 per event (`event`) | `docs/concepts.md` § Executors; `packages/clickhouse/src/normalize.ts` (`e.changes.slice(0, 256)`) |
| Copy link on an event (`event`) | `apps/app/src/components/explorer/event-sheet.tsx` ("Copy link") |
| Logbird records what your code sends (`event` limit) | `docs/SPEC.md` §1 item 2 |
| An operation is the events sharing its id; a parent event places an event under its cause; the same operation id with attempt and outcome shows which try succeeded (`operation`) | `docs/concepts.md` § Operations and § Executors; `packages/clickhouse/src/queries.ts` (operation tree by operation id); `apps/app/src/routes/_authed/_workspace/p.$projectId.operations.$operationId.tsx` |
| Pass the operation id into each job yourself, and the parent event (`operation` limit) | `docs/integrations.md` § Design ("Propagate operationId and parentEventId explicitly into jobs") |
| Workspace activity doesn't record reads (`not`) | `docs/workspace-audit.md` § Activity action catalogue; the compliance page's activity limit |
| Free text searches the description and the actor, account and record names; other fields by name, such as `metadata.channel:whatsapp` (compiled in the test) (`not`) | `docs/query-language.md` § Query language (Text, Attribute rows) |
| Older events keep their original time up to 3,650 days back; an older time is stored as the receive time; retention applies (`not`) | `docs/SPEC.md` §1 (`occurredAt` window); the landing page's guarantees row and its sources in `marketing/copy/home.md` |

## Visuals

`explorer` and `event-detail`, both with dark variants and both opening full size on tap, so they read on a phone. The
operation tree capture has no dark variant yet, so this page doesn't show it; the design pass adds dark variants.
