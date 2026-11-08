# Cloud readiness evidence ledger

Planning baseline: 2026-11-07. This is a source review and test plan until
dated runtime evidence is recorded below. "Fail" means a cloud launch gate remains
open; it does not imply a reproduced exploit. No production deployment is claimed.

| Gate | Status | Evidence / remaining proof |
| --- | --- | --- |
| Every `/api` and `/v1` route inventoried | Static pass | [PR #48](https://github.com/joodlab/logbird/pull/48): 40 concrete routes and 65 auth capabilities; 15 registry/policy tests pass; behavioral auth coverage remains pending |
| Cross-project reads, roles and key scopes | Pending | Matrix integration test prepared; runtime not yet run; existing `requireProjectAccess`, `requireApiKey`, mutation ACL and SQL row-policy suite inspected |
| ClickHouse defense in depth | Partial | Restricted SQL account has policies on all four tables; query-language endpoints use main client and parameterized project filters; compare per-tenant users below |
| No free-form SQL | Source pass; runtime pending | Only guarded boolean expressions in console; public routes reject SQL; AST allowlist and statement-template checks inspected |
| Ingest/read rate limits | Source pass; runtime pending | Shared Redis project+kind buckets; public limits fail open on Redis outage and emit `rate_limit.storage_error`; console reads have no equivalent query limiter |
| Plan quotas and workspace usage | Fail | No plan ledger or workspace event/query/byte counters at baseline; billing must remain a flag-only stub with no payment provider |
| Per-project retention at scale | Pending | Hourly/on-demand worker, leases, exclusive purge lock, selective rollup rebuild present; 10M proof not run |
| Sign-up abuse controls | Partial | Shared auth request limit and hashed/expiring OTP; per-email budgets, disposable-domain config and CAPTCHA hook missing |
| Email deliverability | Pending operator setup | SPF/DKIM/DMARC and SMTP acceptance need a chosen domain/provider and a delivery receipt |
| Workspace/account deletion and workspace export | Fail | Project deletion purges ClickHouse; organization plugin cascades Postgres without CH purge hook; account deletion disabled; project export exists, complete workspace export does not |
| Service observability | Partial | Structured HTTP/worker logs and live/readiness probes exist; metrics endpoint and measured alerting evidence missing |
| Backups and disaster recovery | Pending | Deployment docs describe backups; restore rehearsal and provider receipts not supplied |
| Hosting manifests and status page | Pending | Operations design/manifests tracked separately; no cloud provisioned |
| 10M fictional one-project load | Pending | Requires an isolated load-test environment, sufficient memory/disk capacity and cleanup through project deletion |

## Isolation decision

Keep HTTP authorization authoritative: a key is project-bound; a session must have
current membership in the active project workspace; project id comes from that
authorized context. User query values stay parameters. SQL expressions remain
guarded, never arbitrary statements. The existing SQL account's row policy uses
`SQL_logbird_project`, set by trusted server code per query. It prevents a missing
or broadened predicate from exposing another project, but its credential holder
can choose a different binding. It is not a tenant identity credential.

Per-tenant database users with immutable tenant policies would reduce that
credential's blast radius but introduce user/policy provisioning, revocation,
connection pools, backup/restore and user-count capacity concerns. They also need
separate scoped rollup permissions and lifecycle cleanup. Do not create one user
per event, product tenant or query. The cloud boundary is the Logbird project, not
the optional client event `tenant` field.

Prefer a restricted application read account with the existing request binding
and row policies on every read path, plus route tests. Keep migrations/ingestion
and maintenance on separate credentials. Before switching query-language reads,
measure and choose suitable scan/memory/result budgets: the current SQL profile's
five-million-row read budget is not evidence that a ten-million-event search will
meet latency or completeness requirements. Dedicated project credentials can be
an enterprise isolation tier after its lifecycle and cost are proven. No credential
rotation or database policy changes are authorized by this design note.

## Load protocol

Use a single new fictional project in a `QA Load` workspace. Generate representative
events through `packages/seed`; send 1000-event batches through the real ingest API
and count acknowledged events. Record rejected/retried requests, input bytes,
wall-clock throughput and the exact server/worker revision. Direct ClickHouse
insertion is not ingest-throughput evidence.

Before/after record ClickHouse free disk, active part bytes, table row counts and
container memory; sample peak process/container memory and free disk throughout.
Set memory and disk budgets for the loading, measurement and cleanup window.
Run against isolated fixtures, preserve neighboring data and avoid disrupting
other workloads.

At 10M stored events, measure at least 30 complete HTTP responses per read case,
report p50/p95/p99 with sample count, warm-up, errors, range, concurrency and cache
limitations. Cases: explorer search; `target:` history; `tenant:` history; entity
directory/profile; operation tree; streamed project JSONL export. Measure response
body consumption too, not just response headers. Run export separately with an
explicit size/sample count; an empty or truncated export is failure, not a fast
result. Record client-visible and storage timings separately where available.

Lower retention with slug confirmation, measure the actual completed purge, and
verify expired raw rows plus all aggregate tables. Percentiles require repeated
purges on independently populated windows; one purge yields a duration only.
Finally delete the project through Logbird's deletion API and prove all four tables
have zero rows for its id. Preserve/recheck neighboring project counts. Report
incomplete cleanup explicitly and retain fixture identifiers privately for recovery.

## Evidence to append

- Authorization matrix commands/results and exact head.
- Counts-only orphan inventory, without identifiers or content.
- Load report with p95 numbers, errors, actual row count and cleanup receipt.
- Focused ready PR links, issues with acceptance criteria and remaining decisions.
- Peak measured memory/disk and test processes/artifacts retained or cleaned.

## Validation requirements

Run the route-policy tests, server typecheck and static checks before service
acceptance. Tests with mocked queues or limiters establish source-level behavior
only. Execute the authorization matrix, service integration tests and load
protocol in an isolated test environment; record skipped checks as unverified.
