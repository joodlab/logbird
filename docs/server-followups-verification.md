# Server follow-ups verification - 2026-11-05

Local source and real shared Postgres, ClickHouse, Dragonfly and Mailpit only. Node 22.22.2,
pnpm 10.30.3; server 4851, APP_URL http://localhost:4850. No deployment or frozen QA stack changes.
Fixtures have independent fictional workspaces. The removed QA project was never queried or edited.

## Retention and query HTTP proof

`SERVER_URL=http://127.0.0.1:4851 APP_URL=http://localhost:4850 node --env-file=.env --import tsx scripts/server-followups-proof.ts`

[Recorded curl output](server-followups-evidence.json) contains redacted authenticated curl commands,
status codes, response bodies and timings. Assertions cover a live run returning 503, workspace setup
returning 200 with a busy project and its healthy neighbor, lazy stale-run recovery to failed/abandoned,
continued access, and a completed real retry. They also cover existence/date queries, KQL replacements,
SQL error spans, query/SQL-scoped suggestions, exact attribute counts (pro=2, free=1), and completeness.
A shared worker can consume the queued retry immediately; another 503 while that new run is live is
expected. The suite separately asserts that an independent last-failed run allows reads.

On the existing 300,000-event JoodCMS project, five direct suggestValues calls for metadata.locale took
301.23, 91.88, 74.92, 113.02, 107.77 ms (median 107.77 ms). Counts are actual stored-row counts in
seven days, bounded to 50,000 recent rows. These timings exclude HTTP authentication and transport;
the first call includes cold planning/cache costs, and shared-service load affects latency. They can change as the rolling time window advances.
The rollup fast paths remain for empty-query entity/low-cardinality requests.

## Pool-deadlock and concurrency regression

`APP_URL=http://localhost:4850 node --env-file=.env --import tsx packages/database/scripts/concurrency-proof.ts`

[Recorded concurrency results](server-concurrency-evidence.json). The pre-fix topology is reproduced
with a two-connection pg pool: one transaction holds the project lock, another waits for it, and the
holder's global query queues behind them. The test asserts the blocked states, then rolls back only
its own transactions to release them.

The after-fix test sets DATABASE_URL connection_limit=2 for the real Prisma pool and pauses only the
ClickHouse DELETE call for fictional project A. It runs actual Hono middleware/handlers and all real
backing services; there is no mocked Postgres/queue/auth layer. The mutation stays paused throughout
the request batch and for another two seconds. Results from 105 simultaneous requests:

| Request group | Count | Median ms | Maximum ms | Status |
| --- | ---: | ---: | ---: | --- |
| B reads (events, histogram, facets, overview, entities, fields, suggest, setup) | 50 | 1198.09 | 1681.85 | 200 |
| A reads | 50 | 1353.44 | 1411.94 | 503 + Retry-After: 1 |
| B ingest | 1 | 1537.06 | 1537.06 | 202 |
| /readyz | 1 | 37.11 | 37.11 | 200 |
| A ingest | 1 | 1015.21 | 1015.21 | 503 + Retry-After: 1 |
| A sample removal | 1 | 477.71 | 477.71 | 503 + Retry-After: 1 |
| A deletion | 1 | 1448.48 | 1448.48 | 503 + Retry-After: 1 |

The application used two sessions, with zero idle transactions and zero advisory-lock waiters.
After releasing the delay, the real purge/rebuild completes and A reads return 200. This establishes
pool independence under a deterministic long mutation; it is not a production load benchmark.

## Exclusive-section audit

| Caller | Database usage and result |
| --- | --- |
| Data reads, setup and streaming export | Removed the outer transaction/lock, including next()/auth lookups beneath the old middleware and export's lock-release handshake. Short readiness statements finish before ClickHouse I/O. |
| Ingest | Project existence and retention checks are short Prisma statements; INSERT waits only on the independent session lock. |
| Retention | Run creation, heartbeat and final state use short global Prisma calls. No transaction surrounds DELETE/rebuild. |
| Sample replacement/removal | Readiness followed by ClickHouse delete/rebuild/insert; no transaction or Prisma connection retained. |
| Policy update | Short statements under the session lock. Removed redundant FOR UPDATE, whose previous transaction is gone. Audit and retention enforcement happen after the exclusive section. |
| Project deletion | Key revocation, ClickHouse purge, then project deletion. No retained Prisma connection; audit follows release. Revocation persists if deletion fails, preventing new key writes during a retry. |

The eight-slot lock pool has immediate admission/try-lock rejection, one-second lock_timeout and
two-second statement/acquisition budgets. It is independent of the Prisma application pool. Direct
Postgres or a session-affine connection pool is required for session advisory locks. Existing xact
advisory locks and new session locks use the same key and remain mutually exclusive.

Reads already in progress may overlap maintenance; exports are not snapshots. Live retention returns
503 for new data reads; retention status remains available. Failed rebuilds permit access with possibly
incomplete aggregates until retry. Sample/deletion reads can observe transient aggregates. See SPEC section 4.

No UI was changed; screenshots/video would not demonstrate these backend invariants. The curl receipts,
regression assertions, pool observations and timings are the equivalent review evidence.

## Validation and cleanup

Required commands: pnpm install --frozen-lockfile, pnpm typecheck, pnpm check,
pnpm test --concurrency=1, pnpm build, pnpm openapi:export. The full suite includes
optional HTTP tests disabled by default; the two proof commands above independently execute
real HTTP handlers and real backing services. Focused ClickHouse tests run with the root .env.
The first unbounded parallel run exceeded the seed benchmark's 60-second budget by 0.7 seconds;
the full suite passes with Turbo concurrency=1, without changing that test or its limit.

Cleanup reviewed all task-owned source/contracts and relevant callers. Found and removed the
obsolete export lock handshake, redundant FOR UPDATE, duplicate SQL-position mapper, outdated
transaction comment and redundant retention error wrapper. Corrected ASCII-damaged Unicode
fixtures using source escapes; the three span/parameter tests and real ClickHouse query test pass.
No unrelated refactors, generated-code hand edits or automatic Docker/CI workflows were added.
