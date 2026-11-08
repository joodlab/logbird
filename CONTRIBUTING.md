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

Use Conventional Commits: `feat(server): add capability`, `fix(app): correct behavior`, `docs: clarify setup`. Keep PRs focused and ready for review. Run `pnpm release:check`; explain what/why/verification, contract changes, decisions and limits. Include screenshots and recordings for meaningful UI interactions. Never include credentials, customer data or personal paths. Maintainers merge. This repository has no CI workflows; Docker builds and release checks are manual.
