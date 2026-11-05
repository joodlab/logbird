# Backend QA round 2 verification

2026-11-05, local shared services; base `ddb5fd4`. Node 22.22.0 and pnpm 10.30.3.
No app/UI files, CI workflows, existing keys or QA listeners were changed. The backend listener used 4901;
the Hono example used 4902. Test organizations, projects and keys were fictional and scoped by generated IDs.

## R2-1: timestamp integrity and SDK progress

Policy: omitted occurrence time uses receipt time; supplied ISO-8601/epoch milliseconds must be within
receipt minus 3650 days through plus 24 hours. Numeric magnitudes below 1e11 are rejected with an epoch-seconds
hint. Invalid values produce indexed `rejected[]` entries without poisoning valid siblings.

`pnpm --filter @trailmark/server exec dotenv -e ../../.env -- vitest run src/round2.integration.test.ts --maxWorkers=1`
proves a bare-array HTTP batch accepts three sane past/future/millisecond events and rejects six seconds,
microseconds, extended-year, unparsable, too-old and too-future values; accepted IDs read back from ClickHouse.
The SDK unit regression proves partial rejection diagnostics and permanent 422 handling keep later batches moving.
`node --env-file=.env --import tsx scripts/qa-round2-example.ts` produced:

```text
R2-10 Hono POST /demo -> Executors Demo API; R2-1 real SDK poison dropped, good and later stored, queue=0
```

Migrations 004 and 005 were applied through `pnpm ch:migrate`. They preserve existing rows and disable automatic
TTL materialization. TTL uses receipt time plus 3650 days, does arithmetic in DateTime64 and clamps before casting
to DateTime. Event-time retention remains the worker's responsibility. A live constant-expression check returned
`2106-02-07 06:28:15` for receipt in 2099, and the migration ledger contains both migration names.

## R2-2: retention availability and exact aggregates

Normal zero-expiry sweeps record completed/zero-deletion runs using a shared lock. Retention increases skip the
purge. Expiry checks stop at the first matching row. Actual purges preserve newer minute buckets, recompute the
partial cutoff minute exactly and rebuild only entity/attribute histories touched by deleted rows. Failed or
abandoned runs retain the existing full-repair path on retry, including when raw deletion already completed.

The invitation activity test also increases retention from 90 to 180 days through PATCH and asserts that no retention run is created.
The round2 integration test checks raw/minute totals and surviving entity/attribute counts after a cutoff inside
a minute. There is no partial-bucket approximation.

With the server on 4901, `node --env-file=.env --import tsx scripts/qa-round2-retention.ts` produced:

```json
{"baselineEmptyPurgeMs":8900}
{"projects":93,"untouchedProjects":93,"sweepMs":27465,"probeRequests":208,"readGuardChecks":9672,"unavailable":0,"maxReadIngestPairMs":10278}
```

The baseline invokes the old raw-delete plus three-rollup-delete path on an isolated empty fixture. The sweep
ran the new worker function for every shared project. HTTP read and ingest probes target the fictional fixture;
all 93 untouched projects additionally receive the same read-availability guard used by the HTTP routes, plus
ClickHouse read queries. Probes start every 250 ms. No synthetic events are inserted into existing projects.
The expanded probe load adds thousands of Postgres checks; the maximum combined probe duration was 10.3 s under
that load. An earlier lighter sweep took 8038 ms with 58 HTTP probes and zero 503s; its old empty-purge baseline
was 11631 ms. A single new no-op retention call measured 56-77 ms in focused tests.

## R2-3: invitation activity

`src/invitation-activity.integration.test.ts` uses real OTP login, Postgres, Mailpit and ClickHouse. It accepts,
rejects, resends and cancels invitations through the normal endpoints and asserts exactly one lifecycle event
for each action with the correct actor and invitation ID/email target. The installed better-auth version has
accept/reject/cancel hooks. Its resend path skips creation hooks, so a successful-endpoint wrapper records it.
A new invitation requested with resend=true still uses the normal invited event.

## R2-6: public contracts and OpenAPI

The public search schema accepts only `lang=query`; console SQL schemas are unchanged. `pnpm openapi:export`
exported 41 operations and refreshed both checked-in documents. The round2 integration test asserts the live
public search parameter does not contain sql. Existing console SQL integration tests remain in the full suite.
This PR also adds optional creator email to key/view contracts and bare-array ingest to the public body schema.

## R2-7: bare JSON arrays

A bare array is a supported batch (1-1000 events), documented in SPEC sections 3/5, integrations and the SDK
README. The timestamp regression exercises this shape through POST /v1/events and proves stored accepted IDs.

## R2-9: backend activity data

The invitation activity test deletes a named saved view and renames a project, then reads activity through the
workspace API to verify the view name and exact field/before/after change. It clears the fictional creator's
name and verifies a newly created key returns both creator email and the email fallback as its display name.
The same serializer fallback applies to saved views. Sentence rendering remains owned by the parallel UI work.

## R2-10: example executor identity

Hono, Vue, TanStack and Nuxt examples provide the same explicit demo-api/Demo API executor. The runnable example
proof starts the actual Hono example on 4902, POSTs /demo and checks the ClickHouse-backed Executors directory.
The Setup starter UI remains owned by the parallel app task.

## Repository checks and cleanup

- `pnpm install`: pass using the pinned executable and a pnpm shim on PATH.
- `pnpm typecheck`: 17/17 tasks pass.
- `pnpm check`: pass; existing lint warnings remain.
- `pnpm build`: 11/11 tasks pass.
- `pnpm test --concurrency=2`: 18/18 tasks successful (13 cached); server 14 files / 29 tests passed, with 1 file / 48 tests skipped by existing conditions. The full run took 11m1.644s.
- Final focused invitation/activity/increase test: 1/1 passed in 22.58s, explicit child exit code 0.
- Final typecheck and check rerun after the added assertion: pass.

The test run uses `BULLMQ_PREFIX={trailmark-qa-backend-r2}` on the existing shared Redis service to keep the
older shared worker from consuming recovery fixtures. An initial shared-prefix run hit that recovery race;
another high-concurrency run hit a Vue test worker startup timeout. A subsequent run timed out in
synchronous ClickHouse mutations in existing setup/authorization tests. These are not passing receipts.
The final local run supplies `request_timeout=120000` through the ClickHouse URL (supported by the installed
client) for shared-service mutation load, without changing source defaults or the checked-in environment.
The standard turbo suite can reuse earlier cached/skipped ClickHouse test tasks; the new acceptance tests
run in the server package against real services and do not rely on those skips.

ai-slop-cleanup reviewed the owned diff against the base. It caught an unvalidated invitation organization ID
in the resend preflight (now type-guarded) and duplicated spec prose (consolidated). No remaining actionable
cleanup findings. The scoped SQL is tested against ClickHouse rather than inferred from mocks.

Screenshots/video are not meaningful for these backend-only changes. Executable integration tests, normal
HTTP example execution, readback assertions and dated timing receipts provide equivalent evidence. These are
local results; they do not claim a deployed revision or production proof.
