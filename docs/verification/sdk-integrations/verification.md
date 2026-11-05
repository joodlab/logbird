# Local verification

Measured 2026-11-05 on Windows, Node 26.13.0, pinned pnpm 10.30.3.

- `pnpm install` and final `pnpm install --frozen-lockfile`: pass.
- `pnpm db:generate`: pass against the existing schema; no migration/reset performed.
- `pnpm typecheck`: 16 tasks pass.
- `pnpm check`: pass, with 65 existing repository warnings.
- `pnpm test --concurrency=1`: 18 tasks pass; 220 tests pass, 134 existing opt-in tests skipped.
- `pnpm --filter @trailmark/sdk --filter './packages/integrations/*' build`: five publishable ESM/type builds pass.
- `pnpm --filter @trailmark/sdk --filter './packages/integrations/*' pack --pack-destination <temporary directory>`:
  five tarballs built, runtime/type export targets checked, five packed entrypoints imported, consumer typecheck passed.
- `node --env-file=.env --import tsx scripts/verify-integrations.ts`: all four runnable examples pass real
  ingest/readback on 4730/4731. TanStack captures inside a server function; Vue SSR renders composable data;
  Nuxt uses the registered Nitro plugin and read proxy. Every event's actor, tenant, target and operation
  are checked through the real public read API. History responses contain neither key.
- Pinned dependency publication dates checked against the npm registry: all older than two days.

Earlier concurrent full-suite attempts hit an existing sample-data cleanup query timeout/503 in
setup.integration.test.ts. The final complete sequential run passed without changing that test or server code.

The runtime runner creates an isolated fictional organization/project and two temporary keys, removes its
ClickHouse events and relational fixtures in finally, and stops its own processes. Existing keys and data remain.
No console UI changed; the Vue component is renderless and the examples are API/SSR demonstrations, so
credential-free runtime JSON and terminal assertions provide review evidence instead of screenshots/video.

Cleanup review: reviewed task-owned packages, SDK helpers, examples and wiring against the initial base.
Removed duplicate diagnostic handling, made published read types independent of private contracts, simplified
h3 tests to the framework web handler, and changed the Vue example to render actual composable state.
Tests cover error hooks, request isolation, edge waitUntil registration, selector quoting, stale responses,
pagination deduplication, default denial and authorized query replacement. No unresolved cleanup findings.

Not verified: deployed Workers/Bun, Node 22 execution, production traffic, browser-specific rendering or
publishing to a registry. No publishing, deployment, merge or Docker/CI workflow added. Browser integration
has no ingest method; private keys stay in server config. Contracts did not change.
