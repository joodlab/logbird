---
path: /use-cases/compliance-evidence
module: apps/web/src/content/use-cases/compliance-evidence.ts
---

# Compliance evidence: brief

**The words live in the module.** The page renders `apps/web/src/content/use-cases/compliance-evidence.ts` through the
shared use-case layout (`components/marketing/use-case.tsx`, shape in `content/use-cases/types.ts`). This file holds the
page's job and the proof behind every claim.

## The page's job

The second paid job in depth. It is for the person who answers an auditor, or a customer's security team. It covers:
- what an event can show;
- what retention does and doesn't promise;
- how to hand over an export and show that it matches Logbird's record of it;
- what workspace activity records;
- what Logbird doesn't do.

The landing page's evidence section links here.

## Rules for this page (maintainer, 2026-11-23)

- **Near the export digest:** no "integrity", "tamper", "proof" or "certified". The digest sentence says what a match shows (the file is the one Logbird produced for that export) and what it doesn't (who saved it, when, or that the events were never changed before the export).
- **Units:** the change limit names its unit and source, "up to 256 changes per event".
- **Retention:** lowering retention "starts right away", not "immediate". `docs/SPEC.md` §1 says "immediately purges" and §4 says the worker "runs immediately after retention decreases"; the removal itself takes time on a large table.
- **Gated:** the read API export (`/v1/export`) belongs to the scoped-read work and stays off this page until that gate opens. The steps use the console.

## Proof

| Claim (section) | Source |
| --- | --- |
| Only `action` is required (`event`) | `docs/SPEC.md` §1.1 |
| Actor, impersonator, executor with attempt, tenant, records (`event`) | `docs/concepts.md` (Actors, Tenants, Executors, Records) |
| Up to 256 changes per event in the change fields, shown in the console (`event`) | `packages/clickhouse/src/normalize.ts` (`e.changes.slice(0, 256)`) |
| The evidence export carries the original JSON Logbird stored (`event`, `export` step 2) | `docs/exports.md` § Which format? (`jsonl-evidence`: the normalized event and the stored original JSON, exact digits; not whitespace or number spelling) |
| Logbird records what your code sends (`event` limit) | `docs/SPEC.md` §1 item 2 ("Capture is the client's job") |
| Retention from 7 days to 10 years; new projects at 90 days (`retention`) | `packages/contracts/src/api.ts` `RETENTION_OPTIONS`; `/security` § Retention |
| Hourly deletion; each run recorded and shown in Settings (`retention`) | `docs/SPEC.md` §4 (`RetentionRun`) |
| Lowering: a preview of how many events, type the slug, deletion starts right away (`retention`) | `docs/SPEC.md` §1 item 4 and §4; `/security` § Retention |
| No archive, no undo (`retention.limits`) | `docs/SPEC.md` §1 item 4; `/security` § Retention |
| Only owners and admins change retention; no lock or legal hold (`retention.limits`) | `docs/SPEC.md` §7.1 (PATCH `retentionDays`); no such feature in the code; issue #141 is an open proposal |
| Every member can export (`export` step 1) | `docs/SPEC.md` §7.1 ("GET export … yes yes yes") |
| "Complete (original payloads)" format (`export` step 2) | `docs/exports.md` § Which format? |
| Requested and completed records with id, format, resolved filter and range, query clock, SHA-256, size, rows (`export` step 3) | `docs/exports.md` (opening paragraph; § File-to-record verification); `docs/workspace-audit.md` (`export.requested`, `export.completed`) |
| The verification commands (`export` step 4, `windows`) | `docs/exports.md` § File-to-record verification |
| What a match shows and doesn't (`export` limit) | `docs/exports.md` § File-to-record verification (last sentence); no tamper evidence exists (`/compare` pages: "Tamper evidence: None") |
| An export holds the events received before it started (`windows` limit) | `docs/exports.md` (opening paragraphs) |
| Workspace activity entries; no reads recorded (`activity`) | `docs/workspace-audit.md` § Activity action catalogue |
| No certification, and no compliance claim (`not`) | `/security` ("doesn't hold SOC 2, ISO 27001 or any other certification today") |
| No way to show stored events were never changed (`not`) | No tamper evidence exists |
| No legal hold or retention lock yet (`not`) | Issue #141 is an open proposal, not on `docs/roadmap.md` |

## Visual

`event-detail`: a crop of the reviewed `event-sheet` capture (the detail panel, light and dark), at a size where the text
reads on a laptop.
