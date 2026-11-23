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
- The example queries are compiled by the real query compiler in `use-cases.test.ts`, so the page can't show a
  query the language rejects.
- No tamper, immutable or certified wording.

## Proof

| Claim (section) | Source |
| --- | --- |
| Jump to (Ctrl K) takes an id or a name; an exact id leads; a record is found by its bare id (`find`) | `CHANGELOG.md` 0.2.1 § Highlights and § Entity search (ranking: exact id, id prefix, name prefix, substring, fuzzy) |
| Each account, actor, executor and record has a page with a timeline of every event that mentions it (`find`) | `docs/concepts.md` (opening paragraph and table) |
| An account's page separates what support did while signed in as the customer, and names the support agents (`find`) | `apps/app/src/components/entities/support-split.tsx` ("Not by support" / "Done by support", the agents list); `entity-profile.tsx` renders it on entity pages; the reviewed `tenant` capture |
| A page shows only events sent with that account or record (`find` limit) | `docs/concepts.md` § Tenants and § Records; `docs/SPEC.md` §1 item 2 ("Capture is the client's job") |
| Exact matches, prefixes, ranges and `OR`; suggestions with counts; guarded SQL `WHERE` (`search`) | `docs/query-language.md` § Query language, § Query bar (console), § SQL mode |
| The four example queries (`search`) | `docs/query-language.md` (`tenant:`, `outcome:`, `record:<type>:<id>`, presence `impersonator:*`, prefix `action:booking.*`, relative date `occurredAt:>now-7d`); compiled in `use-cases.test.ts` (each comment sits on its own line, so nothing wraps at phone width) |
| A search covers the chosen range; the explorer offers "Search all time" when matches lie outside it (`search` limit) | `CHANGELOG.md` 0.2.1 § Highlights; `apps/app/src/components/explorer/explorer.tsx` ("Search all time") |
| A cut-short count is a lower bound, shown as "≥ N" or "10,000+" (`search` limit) | `docs/SPEC.md` §4 hot-path rules (`totalExact: false`); `CHANGELOG.md` 0.2.0 § Search totals; maintainer ruling 2026-11-23 (lower bound OK) |
| The explorer capture: booking actions, seven-day histogram, facets for outcome, support, severity and action (`search` visual) | The reviewed `explorer` capture (`marketing/media/staydesk/explorer-*.webp`) |
| Actor and executor with attempt; impersonator; changes, the first 256 per event (`event`) | `docs/concepts.md` § Actors, § Executors; `packages/clickhouse/src/normalize.ts` (`e.changes.slice(0, 256)`) |
| Copy link on an event (`event`) | `apps/app/src/components/explorer/event-sheet.tsx` ("Copy link") |
| Logbird records what your code sends (`event` limit) | `docs/SPEC.md` §1 item 2 |
| An operation groups the request, its jobs and their retries, linked by parent event; retries show each attempt on the same executor (`operation`) | `docs/concepts.md` § Operations and § Executors |
| A job joins the operation only when you pass its operation id and parent event (`operation` limit) | `docs/integrations.md` § Design ("Propagate operationId and parentEventId explicitly into jobs") |
| Workspace activity doesn't record reads (`not`) | `docs/workspace-audit.md` § Activity action catalogue; the compliance page's activity limit |
| Free text searches the description and the actor, account and record names; other fields by name, such as `metadata.channel:whatsapp` (`not`) | `docs/query-language.md` § Query language (Text, Attribute rows) |
| Older history can be imported with its original time; retention still applies (`not`) | The landing page's guarantees row (`occurredAt` up to 3650 days back; project retention applies to imports) and its sources in `marketing/copy/home.md` |

## Visuals

`explorer` and `event-detail`, both with dark variants and both opening full size on tap, so they read on a phone. The
operation tree capture has no dark variant yet, so this page doesn't show it; the design pass adds dark variants.
