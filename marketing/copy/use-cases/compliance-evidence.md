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
| Up to 64 records per event indexed; the evidence export keeps all of them in the original JSON (`event`) | `packages/clickhouse/src/normalize.ts` (`e.targets.slice(0, 64)`); `docs/exports.md` § Which format? |
| Up to 256 changes per event in the change fields, shown in the console (`event`) | `packages/clickhouse/src/normalize.ts` (`e.changes.slice(0, 256)`) |
| The evidence export carries the original JSON Logbird stored (`event`, `export` step 2) | `docs/exports.md` § Which format? (`jsonl-evidence`: the normalized event and the stored original JSON, exact digits; not whitespace or number spelling) |
| Logbird records what your code sends (`event` limit) | `docs/SPEC.md` §1 item 2 ("Capture is the client's job") |
| Retention from 7 days to 10 years; 90 days is the default for a new project, which can choose another (`retention`) | `packages/contracts/src/api.ts` `RETENTION_OPTIONS`; `apps/app/src/components/projects/new-project-dialog.tsx` |
| Hourly deletion; Settings shows the latest run (`retention`) | `docs/SPEC.md` §4 (`RetentionRun`); `apps/server/src/routes.ts` (retention status reads the latest run) |
| Lowering: an estimate of how many events when it is available, type the slug, deletion starts right away (`retention`) | `docs/SPEC.md` §1 item 4 and §4; `apps/app/src/routes/_authed/_workspace/p.$projectId.settings.retention.tsx` (the estimate can be unavailable) |
| No archive, no undo (`retention.limits`) | `docs/SPEC.md` §1 item 4; `/security` § Retention |
| Only owners and admins change retention; no lock or legal hold (`retention.limits`) | `docs/SPEC.md` §7.1 (PATCH `retentionDays`); no such feature in the code; issue #141 is an open proposal |
| Every member can export (`export` step 1) | `docs/SPEC.md` §7.1 ("GET export … yes yes yes") |
| "Complete (original payloads)" format (`export` step 2) | `docs/exports.md` § Which format? |
| Each admitted export gets a requested record and an ending; a completed record keeps id, format, resolved filter and range, query clock, SHA-256, size, rows; an unconfirmed ending has no digest (`export` step 3) | `docs/exports.md` (opening paragraph; § File-to-record verification; § Audit lifecycle and failures: refusals before admission leave no record, `export.outcome_unknown` has no digest); `docs/workspace-audit.md` |
| The verification commands (`export` step 4, `windows`) | `docs/exports.md` § File-to-record verification (`sha256sum`, `wc -c`, `Get-FileHash`, `(Get-Item).Length`); `shasum -a 256` is the macOS equivalent of `sha256sum`. The filename is set once in a quoted variable so the commands can be copied. |
| What a match shows and doesn't, in one sentence (`export` limit) | `docs/exports.md` § File-to-record verification (last sentence); no tamper evidence exists (`/compare` pages: "Tamper evidence: None") |
| An export holds the events received before it started (`windows` limit) | `docs/exports.md` (opening paragraphs) |
| Workspace activity entries: invitations, joins through an invitation or link, removals by an owner or admin, role changes; sign-ins, sign-outs, revoked sessions, members' failed sign-ins (summarised when repeated); not reads, and not a member leaving on their own (`activity`) | `docs/workspace-audit.md` § Activity action catalogue and § sign-in failures; `packages/auth/src/server.ts` (`afterRemoveMember` writes `member.removed`; the self-service leave path doesn't call it) |
| No certification, and no claim that using Logbird makes you compliant (`not`) | `/security` ("doesn't hold SOC 2, ISO 27001 or any other certification today, and we don't claim that using it makes you compliant") |
| No way to show stored events were never changed (`not`) | No tamper evidence exists |
| No legal hold or retention lock yet (`not`) | Issue #141 is an open proposal, not on `docs/roadmap.md` |

## Visual

`event-detail`: a crop of the reviewed `event-sheet` capture (the detail panel, light and dark), at a size where the text
reads on a laptop.
