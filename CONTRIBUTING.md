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
| `pnpm openapi:export` / `pnpm openapi:check` | Regenerate `openapi/` from the running code / fail if the committed files differ |
| `pnpm release:check` | Full checks plus API export drift verification |

Before handoff, run `pnpm install`, `pnpm typecheck`, `pnpm check`, `pnpm test` and `pnpm build`. Exercise service-dependent behavior against real Postgres, ClickHouse and Redis with isolated fictional fixtures. Never reset a shared database or flush a shared cache. ClickHouse tests expect a migrated database; run `pnpm ch:migrate` separately. `CLICKHOUSE_TEST_MIGRATE=1` explicitly opts integration tests into migration execution against their configured database.

`packages/contracts` defines the API; server implements it and app consumes it. Keep contract and implementation changes in the same PR. Reuse `packages/ui` components. Do not add abstractions without a concrete need. Follow the package's existing Vitest tests and cover the behavior being changed.

## CI and service-dependent tests

The required `Quality` job uses Node 22 and the pinned pnpm version to install with
`--frozen-lockfile`, typecheck, run Biome, run `pnpm test:unit`, and run `pnpm openapi:check`. That last step exports
the API in-process with placeholder settings (no services) and fails if the committed `openapi/` files differ. When it
fails, run `pnpm openapi:export` and commit the result. PR titles must
follow Conventional Commits; Gitleaks scans Git history on PRs and pushes.
The Docker workflow builds the images on PRs that touch Dockerfiles or Compose files; only the tag-driven release workflow publishes them.
The query bar's corpus test (`apps/app/src/components/query-input/query-corpus.test.tsx`, about ten minutes) runs in
its own `Query corpus` workflow, in four parallel shards. It runs on PRs that touch the query bar, the console's query
language files, the contracts' query files or `packages/clickhouse/src/query*`, and on every push to `master`. Quality
leaves it out with `LOGBIRD_QUERY_CORPUS=skip`. A local `pnpm test` still runs it. To run just the corpus, use
`LOGBIRD_QUERY_CORPUS=only pnpm --filter @logbird/app test`; add `LOGBIRD_QUERY_CORPUS_SHARD=i/n` for one share of it.

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

The purge-heavy server suites (`immutable-ingest*`, `destructive-maintenance`, `exports`
and `own-audit`) wait on ClickHouse lightweight DELETEs, and those take longer as the
shared tables gain active parts. On a long-lived development store one purge can take
30–40 s. Set `LOGBIRD_TEST_SLOW_STORE=1` for such a run: it multiplies by six only the
limits of work that issues a DELETE (the cleanup hooks that purge the fixture, waits on a
background DELETE, and test bodies that run retention, sample removal, project deletion
or an ingest recovery that rebuilds rollups). Fixture setup and every other test body keep
their committed limits. Leave it unset (or `0`) otherwise; any other value is refused.
Turbo hashes the variable, and CI uses the committed limits. A test that still times out
with it set is a finding, not noise.

## Page snapshots (marketing site)

`apps/web/src/content/page-snapshots.test.ts` renders every page of the marketing site in each repository × Cloud
state and compares it with committed text snapshots in `apps/web/src/content/__snapshots__/pages/<state>/`. One walk over
each page's `<body>` lists its headings, visible text (one block per line, with screen-reader-only, `aria-hidden`,
hidden and `noscript` text marked, image alt text and `<pre>` lines), links (text and href) and form controls (name,
type, value, placeholder, label, state and text), in document order.

- Each page's file has its title and description and all of those lines, with each run of lines from the shared shell
  (the skip link, the header and the footer) replaced in place by one `[shell: … — see _shell.txt]` marker. Text
  outside the shell, and the order of the regions, stay in the page file.
- `_shell.txt` (one per state) holds the shell's lines once. Every page in the state must produce exactly those lines
  and the same shell markup as the home page; the router's active-link marks are the only allowed difference, and they
  must sit, complete, on exactly the links to the current page and its section.

A change to any of that fails until the snapshots are updated: a header or footer wording change in the four
`_shell.txt` files only. Styling, classes, layout, images without alt text and attributes outside the list above are
not snapshotted (the shell's full markup is compared, not snapshotted).

To update them after an intended change, run from the repository root:

```sh
pnpm --filter @logbird/web exec vitest run src/content/page-snapshots.test.ts --update
```

Put `--update` after the path (`-u` before it takes the path as its value). Then read `git diff` of the `.txt` files:
only the changes you meant should appear, in every state they apply to. Commit the snapshots with the change.

CI only verifies. The update refuses to run, and fails before anything is written, whenever vitest treats the run as CI:
`CI` set to any non-empty value (`true`, `1` and `yes`, and also `0` and `false`, which vitest 4 counts as CI too), or a
CI provider's own variable such as `GITHUB_ACTIONS`. Only an unset or empty `CI`, with no provider variable, allows it.

In a pull request that changes copy, the snapshot diff is the review surface. The reviewer reads the diff, not just
the module change. The author states in the PR body which sentences changed and why (a new claim names its source,
usually in the page's brief under `marketing/copy/`).

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
