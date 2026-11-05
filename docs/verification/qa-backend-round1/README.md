# Backend QA round 1

Verified locally on 2026-11-05 using Node 22.18.0 and pinned pnpm 10.30.3.
Shared Postgres, ClickHouse, Dragonfly and Mailpit; fictional isolated projects only.
The frozen stack on 4800/4801 was not modified. Example processes used 4871/4872.

## Acceptance commands

```powershell
pnpm --filter @trailmark/server exec dotenv -e ../../.env -- vitest run src/qa-backend.integration.test.ts --maxWorkers=1
node --env-file=.env --import tsx scripts/verify-integrations.ts
node --import tsx scripts/verify-sdk-backpressure.ts
```

Use an isolated `BULLMQ_PREFIX` such as `{trailmark-qa-backend}` for verification to prevent
an existing shared worker from consuming fixture jobs. Do not pass dotenv's `-o` option.
All created projects, keys, events, organizations and users are removed by the tests' finally blocks.
No existing keys are changed.

## T3: read failure handling

Vue SSR renders `Audit history unavailable. Please retry.` with `role=alert` and HTTP 502.
It does not throw from serverPrefetch. Error paths flush captured events and catch transport
failures. Hono and TanStack handlers also return 502; shutdown rejections are handled.
The Vue composable already exposes errors; a new initial-failure/recovery regression tests that contract.
Nuxt's request fetcher propagates failures to the same composable error state.

Observed runner output:

```text
vue: read failure 502, rendered error, process alive, buffered audit event flushed
```

The runner sends a mutation, supplies an invalid read key, checks error HTML/status, reads back
the buffered event through a valid key and proves that another mutation still returns 200.

## T4: bounded SDK queue

Default 10,000 queued events, plus one in-flight batch. Configurable oldest/newest overflow,
onDrop callback, dropped counter, queueSize. Failed batches are trimmed when requeued;
throwing diagnostic hooks cannot escape capture. The count cap is documented as distinct from bytes.

Real dead endpoint acceptance: 5,000 captured events with capacity 10 yields queueSize=10,
dropped=4,990. Flush/shutdown reject transport failure and the queue remains 10.
The validator-style 50,000-event default-capacity repro also passes:

```json
{"tracked":50000,"queueLength":10000,"dropped":40000,"heapGrowthMB":34}
```

Heap growth is a measured process delta, not a byte cap or a cross-machine guarantee.
Unit tests additionally hold a batch in flight, overflow the queue, fail the batch and verify
both policies preserve the expected event order and callback/counter counts.

## T9: configurable example reads

All three explicit history handlers share their capture endpoint configuration. Nuxt already
used its module configuration. The runner deliberately uses non-default endpoint 4871.

```text
hono: real ingest and history read passed
vue: real ingest and history read passed
tanstack-start: real ingest and history read passed
nuxt: real ingest and history read passed
```

Each history endpoint returns 200 with its demo action, and actor, tenant, target and operation
are read back from ClickHouse through the public API. No keys appear in history output.
See ../sdk-integrations/runtime-results.json for the dated receipt.

## T10: saved view validation (server)

Create compiles state.q using compileQuery or the restricted SQL validateSql guard before writing.
Invalid query types, a SELECT statement and an unknown SQL column return 422 invalid_query
with language-specific details. Valid query and SQL views each return 201 and list/restore
their exact saved state. The real-service regression asserts all these boundaries.
The UI save-dialog guard is owned separately.

## T12: coherent sample stories

Real-service acceptance loads 2,000 rows and checks all 400 operations for one tenant and actor,
created -> confirmed -> invoice issued -> payment processed sequence, room-specific targets,
and successful second payment attempts after selected failures. A separate aggregate over every
target id checks one tenant per record. Display numbers match ids and parent ids form the story tree.

## T13: OpenAPI server and request examples

APP_URL supplies the advertised instance URL. Ingest has an action-only JSON request example;
read q has an example from the contracts schema. Both OpenAPI JSON exports are regenerated.
The runner serves the specification over HTTP and executes both examples against its advertised URL.

```text
openapi: advertised instance URL and ingest/read request examples passed real HTTP (202/200)
```

## T16: human audit names (server)

API keys use their names on create/revoke. Invite links use their role as label. Project changes,
retention/setup/sample actions use project names. Auth hooks use member/invitation emails and
organization names. Nameless actors fall back to email. The real-service regression creates and
revokes a named key/link and joins through the link as a nameless OTP user; workspace activity
readback asserts names and the joiner's email. The UI sentence builder is owned separately.

## T19: SQL statement guidance

Leading SELECT/WITH returns 422 not_allowed with:
`Enter only a WHERE expression (e.g. outcome = 'failure')`.
The real-service regression checks SELECT, WITH and an actual nested SELECT; nested subqueries
retain `Subqueries are not allowed`.

## Review and evidence limits

Backend/SDK and example-handler changes only; no console or email package edits and no CI changes.
Screenshots/recordings are not meaningful for these API/SDK changes: status, returned error HTML,
process survival and persisted readback are the equivalent verification above. Console visuals
and sentence composition belong to the parallel UI change.

Cleanup review inspected the owned diff against master 3768bd8, callers and tests; no actionable
slop found. No speculative abstractions or dependencies were introduced. This is local-service
proof, not hosted or production acceptance.

## Final local check receipts

```text
pnpm install: lockfile up to date; pnpm 10.30.3, exit 0
pnpm typecheck: 16 successful / 16 tasks, exit 0
pnpm check: 352 files checked; 74 advisory warnings; exit 0
BULLMQ_PREFIX={trailmark-qa-backend} pnpm test: 18 successful / 18 tasks, exit 0
  server: 12 files passed, 1 skipped; 27 tests passed, 48 skipped
  skipped: opt-in Search v2 HTTP suite (SEARCH_V2_HTTP is not enabled)
  existing role-authorization and project-lock regressions included and passed
pnpm build: 10 successful / 10 tasks, exit 0
pnpm openapi:export: Exported 41 operations in-process
focused qa-backend.integration.test.ts: 1 file, 2 tests passed
```

The final full suite took 6m04s; Turbo reports no coverage output files because the tests do
not produce coverage artifacts. No test failures or fork-termination warning on this final run.
An earlier unisolated run encountered a retention job and another emitted a fork-termination
warning; neither is used as the final receipt. The rebase added master #33 documentation
only; typecheck/build were repeated successfully afterward. Cleanup scope and contract
review remain valid on the rebased code.
