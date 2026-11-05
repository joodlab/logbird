# Open-source and production-test verification

Local verification on 2026-11-05. No deployment, public visibility change, package publishing or customer-data acceptance was performed.

## Checks

- `pnpm install --frozen-lockfile`: passed using pnpm 10.30.3.
- `pnpm typecheck`: 16 successful tasks.
- `pnpm check`: passed with 65 existing warning-level diagnostics, no errors.
- `pnpm test`: 18 successful tasks after the SDK integration rebase. Server: 19 passed, 48 skipped; app: 42 passed. The optional HTTP search matrix remains disabled. Real Postgres, ClickHouse, SMTP and Redis integration tests ran. Server tests run serially; the setup test allows 240 seconds for real ClickHouse sample rebuilds and teardown (the original 120-second budget timed out during cleanup).
- `pnpm build`: all 10 build tasks passed, including server, worker and console. Declaration generation now uses a dedicated RPC tsconfig so builds do not emit declarations beside test fixtures or scripts.
- `pnpm release:check`: passed on the combined branch (16 typecheck tasks, 18 test tasks and 10 build tasks; Turbo reused applicable earlier results).
- `pnpm openapi:export` and `git diff --exit-code -- openapi`: passed; 41 documented operations. Contracts unchanged; liveness/readiness are operational endpoints.
- Both Compose files pass `docker compose ... config --quiet`. No backing containers were started.
- All three multi-stage images build successfully and configure user `node`. Workspace pruning retains migration tooling; these are not minimal production-dependency-only images.

## Production runtime

Built console on port 4740, API on 4741 and built worker were started with NODE_ENV=production against existing local dependencies. Observed server.ready and worker.ready. The same-origin console proxies API calls in the production build.

```text
/health 200 { status: ok, postgres: true, clickhouse: true }
/readyz 200 { status: ok }
/livez 200 { status: ok }
PASS app CSP and API health proxy
PASS disallowed CORS
PASS ingest + read
PASS console Query + guarded SQL
PASS public listener and unauthorized API check
```

The runtime smoke wrapper used Mailpit OTP sign-in, a fresh fictional workspace/project and keys; it removed its own fixtures afterward. SQL tests included rejection of a system-table SELECT. The standalone smoke script explicitly skips optional inputs it does not receive. Redis regression tests prove independent middleware instances share a counter and return 429 with Retry-After. Oversized management requests return a structured 413; ingestion retains its existing decoded gzip/identity limit.

The broader `pnpm e2e` script passes OTP, invitation management, ingest/read, gzip, malformed/oversized inputs, schema checks and saved views, then fails on retention lowering at scripts/e2e-smoke.ts:129 with a storage 503. Reproduced twice after the body-limit fix. This is an unresolved first-production acceptance blocker; no complete E2E pass is claimed. Retention internals were kept outside this cross-cutting task.

TLS/cookie behavior for a real HTTPS domain, off-host backups and restore rehearsal, live SMTP provider, Linux signal/drain behavior, and actual VM deployment remain unverified. Health checks alone do not establish retention execution or production readiness. All task-owned app, server and worker processes were stopped afterward; ports 4740/4741 were verified without listeners.

## Publication audit

A bounded scan covered 1,521 historical blobs for private-key headers, common GitHub/AWS/service token patterns, credential URLs and personal paths. The only credential-pattern match was the documented CHANGE_ME connection-string placeholder in .env.example; no credential findings remained after inspecting that match. Eight current configured password/secret values were also compared privately against reachable history with zero matches; values were never printed. This does not establish an exhaustive secret-free history.

Historical personal paths/local instructions remain in AGENTS.local.md, AGENTS.md, docs/SPEC.md, docs/research/hyperdx-clickhouse.md and docs/sdk-generation.md blobs. History was not rewritten. The owner must decide how to handle that history before making the repository public. Current tracked text was scrubbed of personal workstation paths and private service instructions. Original local notes are preserved in the primary checkout's ignored AGENTS.local.md; the public guide documents this optional file.

README uses the existing marketing capture; this task changes infrastructure and documentation, so a new interaction video is not meaningful. HTTP assertions and image builds provide equivalent verification. Existing captures do not prove new production infrastructure.

## Cleanup review

Reviewed task-owned diff against master after integrating PRs #21 and #23. Removed duplicate in-memory invite limiting in favor of shared Redis enforcement, avoided a second ingest body limiter, and restricted declaration generation to its actual entry point. No further actionable slop found in the reviewed scope. Checks above cover the changes; the retention failure and deployment limits remain open.

## Decisions needed

Domain/cloud signup URL; hosting provider/region/capacity; SMTP provider and verified sender; disclosure and conduct contact plus GitHub private reporting; backup destination/retention and recovery objectives; monitoring destination; treatment of historical personal paths. Resolve the retention smoke failure before accepting customer data. No payment or infrastructure purchase is authorized by this PR.
