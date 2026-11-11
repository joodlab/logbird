# Contributing to Logbird

Use Node 22.18+ and pnpm 10.30.3 (`packageManager` is authoritative). You also need Git and Docker with Compose for local dependencies. Read [SPEC](docs/SPEC.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through the [security policy](SECURITY.md).

## Development from zero

```sh
git clone https://github.com/joodlab/logbird.git
cd logbird
corepack enable
corepack prepare pnpm@10.30.3 --activate
sh scripts/selfhost-init.sh
```

Edit `.env` for source development before starting services:

- `APP_URL=http://localhost:4600`, `SERVER_URL=http://127.0.0.1:4601`, `PORT=4601`.
- `DATABASE_URL=postgresql://logbird:<POSTGRES_PASSWORD>@127.0.0.1:5432/logbird` (URL-encode the password).
- `CLICKHOUSE_URL=http://127.0.0.1:8123`, `CLICKHOUSE_DATABASE=logbird`, `CLICKHOUSE_USER=logbird`; keep the initialized password.
- `REDIS_URL=redis://127.0.0.1:6379`, `BULLMQ_PREFIX={logbird}`.
- `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`, `SMTP_SECURE=false`, `SMTP_REQUIRE_TLS=false`; leave SMTP user/password empty for Mailpit.

Use the plain development Compose file for backing services, then run the application from source:

```sh
docker compose -f docker-compose.dev.yml up -d
pnpm install
pnpm db:generate
pnpm db:deploy
pnpm ch:migrate
pnpm --filter @logbird/clickhouse create-query-user
pnpm dev
```

The query-user command preserves existing keys and may append missing local query credentials to `.env`. Never commit that file. The console is at <http://localhost:4600>, API at <http://localhost:4601>, email preview at <http://localhost:4602>, and Mailpit at <http://localhost:8025>. Sign in with a fictional email; Mailpit catches the code without sending real mail.

Maintainers with existing services can use those instead of Compose. Use an isolated project namespace and preserve other users' data. Stop source servers and workers after use; an abandoned worker can consume another checkout's queue. Stop your own Compose services with `docker compose -f docker-compose.dev.yml stop`; avoid deleting volumes unless you intend to discard your own local data.

## Commands and verification

| Command | Purpose |
| --- | --- |
| `pnpm dev:server`, `pnpm dev:app` | Run only the API or console and dependencies |
| `pnpm demo --until now` | Load the fictional Acme / StayDesk and Ledger demo; replaces events in those demo projects |
| `pnpm typecheck` | Check TypeScript across the monorepo |
| `pnpm check` / `pnpm fix` | Check / apply Biome and Ultracite formatting |
| `pnpm test` | Unit and service integration tests |
| `pnpm build` | Build all packages and applications |
| `pnpm release:check` | Full checks plus API export drift verification |

Before handoff, run `pnpm install`, `pnpm typecheck`, `pnpm check`, `pnpm test` and `pnpm build`. Exercise service-dependent behavior against real Postgres, ClickHouse and Redis with isolated fictional fixtures. Never reset a shared database or flush a shared cache. ClickHouse tests expect a migrated database; run `pnpm ch:migrate` separately. `CLICKHOUSE_TEST_MIGRATE=1` explicitly opts integration tests into migration execution against their configured database.

`packages/contracts` defines the API; server implements it and app consumes it. Keep contract and implementation changes in the same PR. Reuse `packages/ui` components. Do not add abstractions without a concrete need. Follow the package's existing Vitest tests and cover the behavior being changed.

## CI and service-dependent tests

The required `Quality` job uses Node 22 and the pinned pnpm version to install with
`--frozen-lockfile`, typecheck, run Biome, and run `pnpm test:unit`. PR titles must
follow Conventional Commits; Gitleaks scans Git history on PRs and pushes.
The Docker workflow builds the images on PRs that touch Dockerfiles or Compose files; only the tag-driven release workflow publishes them.

`pnpm test:unit` runs every test outside the server except `*.integration.test.ts`,
the server's three pure export regression suites, and the self-hosting/Kubernetes
script tests. Package concurrency and Vitest workers are capped at two so concurrent
cold transforms do not exhaust small CI runners. It does not need backing services. The broader server suite stays
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

## Issues, commits and pull requests

Look for the [good first issue](https://github.com/joodlab/logbird/labels/good%20first%20issue) label. For a larger change, open a feature request or Discussion before investing in implementation. Bug reports should include a minimal fictional reproduction, version, expected result and actual result.

Create a focused branch and use Conventional Commits, for example `feat(server): add capability`, `fix(app): correct behavior`, or `docs: clarify setup`. Use a conventional PR title, rebase on `origin/master`, and open the PR ready for review. Explain what changed, why, how it was verified, contract changes and remaining limits. Attach screenshots for UI changes and a short recording when interaction matters; use [the media capture guide](docs/media/README.md) for public demo assets. Never include credentials, customer data or personal paths.

GitHub Actions runs the required `Quality` check, PR-title lint and Gitleaks on every PR; fix failures before asking for review. PRs that touch Dockerfiles or Compose files also build (never push) the four release images and the marketing site image. Maintainers review and merge; do not merge your own PR.

## Releases and changelog

Releases are tag-driven: a maintainer updates `CHANGELOG.md` with 1–3 `### Highlights` bullets, bumps versions and pushes a stable `vX.Y.Z` tag. Below 1.0, every release bumps the patch number (0.1.0 → 0.1.1); only a breaking change bumps the minor number (0.1.x → 0.2.0), see [choosing the version](docs/releases.md#choosing-the-version). Preflight generates notes with changelogithub before publishing multi-arch images; the GitHub Release follows only when all four images succeed.

The squash-merge PR title becomes the commit subject and the changelog line. Use a concise description of the resulting behavior. Add a scope for the affected area, such as `fix(server): handle retries`; related changes are grouped by scope. Add `!` before the colon for a breaking change, such as `feat(sdk)!: require project keys`, to put it in **Breaking changes**.

| Type | Section | Type | Section |
| --- | --- | --- | --- |
| `feat` | Features | `fix` | Bug fixes |
| `perf` | Performance | `refactor` | Refactoring |
| `docs` | Documentation | `build` | Build |
| `ci` | CI | `test` | Tests |
| `chore` | Maintenance | `revert` | Reverts |
| `style` | Style | Other subjects/types | Other changes |

Human authors and co-authors receive credit; bots, AI coding agents and placeholder identities never do, including `Co-Authored-By` trailers. Describe user-facing behavior and upgrade considerations in your PR; do not invent release entries or change versions in an unrelated PR. Preview with `pnpm release:notes:dry -- --version vX.Y.Z --to HEAD` using an authenticated `gh` session. See [releases](docs/releases.md), [self-hosting](docs/self-hosting.md) and [Coolify](docs/coolify.md) for the procedure and failure handling.
