# Contributing

Use Node 22.18+ and pnpm 10.30.3 (packageManager is authoritative).

```sh
cp .env.example .env
# Fill credentials; use localhost dependency URLs for source development.
docker compose -f docker-compose.dev.yml up -d
pnpm install
pnpm db:generate
pnpm db:deploy
pnpm ch:migrate
pnpm --filter @logbird/clickhouse create-query-user
pnpm dev
```

App: localhost:4600; API: localhost:4601; email preview (`apps/email`): localhost:4602; Mailpit: localhost:8025.
You may use existing development services instead of Compose. Use an isolated project namespace and preserve other users' data.

ClickHouse tests expect a migrated database. They do not apply migrations implicitly.
Run `pnpm ch:migrate` separately; `CLICKHOUSE_TEST_MIGRATE=1` explicitly opts the
package integration test into migration execution against its configured database.

packages/contracts defines the API; server implements it and app consumes it. Keep schema changes in the same PR. Reuse packages/ui components. Use Biome/ultracite formatting, Vitest tests and isolated fictional fixtures.

Use Conventional Commits: `feat(server): add capability`, `fix(app): correct behavior`, `docs: clarify setup`. Keep PRs focused and ready for review. Run `pnpm release:check`; explain what/why/verification, contract changes, decisions and limits. Include screenshots and recordings for meaningful UI interactions. Never include credentials, customer data or personal paths. Maintainers merge. GitHub Actions runs CI on pull requests and master pushes; releases are tag-driven. PRs that touch Dockerfiles or Compose files build (never push) the four images; pushing a `v*` tag publishes multi-arch images to GHCR and creates the GitHub Release (see docs/releases.md).

## CI and service-dependent tests

The required `Quality` job uses Node 22 and the pinned pnpm version to install with
`--frozen-lockfile`, typecheck, run Biome, and run `pnpm test:unit`. PR titles must
follow Conventional Commits; Gitleaks scans Git history on PRs and pushes.
The Docker workflow builds the images on PRs that touch Dockerfiles or Compose files; only the tag-driven release workflow publishes them.

`pnpm test:unit` runs every test outside the server except `*.integration.test.ts`,
the server's three pure export regression suites, and the self-hosting/Kubernetes
script tests. It does not need backing services. The broader server suite stays
local-only for now: even its `unit` Vitest project installs `test-services.ts`,
whose cleanup connects to Postgres and Redis, and several plain `*.test.ts` files
exercise real services. Integration suites also require migrated ClickHouse with
the restricted query user and row policies, Mailpit, and enough resources for
long-running ingest, crash-recovery and export-load scenarios. Running only files
named `integration` in containers would not cover that dependency boundary.

Before release, run the full service-backed `pnpm test` and `pnpm release:check`
against an isolated fictional namespace with Postgres, ClickHouse, Redis-compatible
storage and Mailpit configured in `.env`. Apply migrations and create the restricted
query user explicitly as documented above. Never reset shared databases. Quality
is a service-free gate, not evidence that the integration/release checks passed.
Load the root environment for every package, for example
`pnpm exec dotenv -e .env -- pnpm test` (and the same wrapper for `pnpm release:check`).
