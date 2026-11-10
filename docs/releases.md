# Releases and container images

The self-host stack uses stable SemVer tags `vMAJOR.MINOR.PATCH`. All tracked
package manifests (including the SDK, integrations and examples) share that version.
Git tags include `v`; package versions, image tags and `LOGBIRD_VERSION` omit it.
The first release is prepared as 0.1.0; the workflow must finish before its images
or GitHub Release can be treated as available.

## Prepare a release

1. Start a release PR from master. Add `## X.Y.Z` to CHANGELOG.md with one to
   three user-facing bullets under `### Highlights`. Document configuration,
   migration, recovery and known limits. Keep an empty `## Unreleased` for later work.
2. Set every tracked package.json version to X.Y.Z, including examples and SDK
   integrations. Run `pnpm release:version`; passing a tag additionally checks it:
   `pnpm release:version v0.1.0`. Update the Compose default and .env.example version
   when selecting a new recommended self-host release.
3. Use Node 22.18+ and pnpm 10.30.3. Prepare isolated fictional service fixtures,
   current additive migrations and the restricted ClickHouse query account, then run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm release:check
   mkdir -p .tmp
   pnpm release:notes:dry -- --version v0.1.0 --to HEAD --output .tmp/release-notes.md
   ```

   Authenticate with `gh auth login` first (or provide `GH_TOKEN`/`GITHUB_TOKEN`).
   Every commit in the range must already be on GitHub (identity lookups query
   GitHub; an unpushed commit fails as an incomplete lookup), and `CHANGELOG.md`
   needs the version's Highlights; for a preview before that, pass `--changelog`
   with a scratch file.
   The wrapper uses changelogithub's output APIs and read-only GitHub identity
   lookups. It never creates/edits a release, including without `--dry`. The first
   release includes all non-merge history, including the root commit; later releases
   use the nearest preceding reachable stable `vX.Y.Z` tag, ignoring prereleases.
   `--from vX.Y.Z` overrides the baseline and must be an ancestor. Compare links
   use the baseline and new version; first releases link the full commit history.
   Highlights must exist in the exact version section; missing/empty/comment-only
   or more than three bullets fail closed. Preview output belongs in the release PR.

   To simulate the next release, put its version and reviewed Highlights in a
   scratch Markdown file, then use `--changelog .tmp/next-changelog.md --version
   v0.2.0 --to origin/master --from v0.1.0`. This does not edit CHANGELOG.md or tags.
4. Build all four images locally (below), validate both Compose configurations,
   and prove fresh install, SMTP login, workspace/project/key creation, ingest/read,
   exports, retention and matched fresh-storage restore using fictional data.
   For an upgrade preserve pre-existing events/settings/keys and all credentials.
   Before the first versioned release record the accepted source commit baseline.
   A build or green CI does not prove application/upgrade acceptance. Record unrun
   gates; see [self-hosting](self-hosting.md) and the existing #77/#88 limits.
5. Merge through the maintainer process and wait for the master `Quality` job.
   An authorized maintainer tags the exact accepted commit and pushes the tag:

   ```sh
   git fetch origin
   git switch --detach <accepted-master-sha>
   node scripts/check-version-consistency.mjs v0.1.0
   git tag -a v0.1.0 -m "Logbird v0.1.0"
   git push origin v0.1.0
   ```

   After the GitHub Release exists, refresh the site's fallback list with
   `pnpm --filter @logbird/web releases:sync` in a follow-up PR, and redeploy the
   hosted site without cache ([Coolify](coolify.md#hosted-marketing-site-logbirdjoodlabcom-only)).
   Do not move/reuse a published version tag. Release automation is publication,
   not a production deployment or authorization to bypass acceptance.

## What the tag workflow does

`.github/workflows/release.yml` runs on `v*` pushes. Its preflight requires a
stable X.Y.Z tag matching every manifest, verifies the tagged commit is on master,
and requires the latest GitHub Actions `Quality` check to have succeeded for that
exact commit in successful master push CI (`.github/workflows/ci.yml`). A tag pushed
before Quality finishes fails; rerun the failed workflow after CI passes.

The workflow tests the release tooling and generates notes before building. It
then builds/pushes these four images for `linux/amd64` and `linux/arm64`:

| Role | Image | Dockerfile target |
| --- | --- | --- |
| API | ghcr.io/joodlab/logbird-server | apps/server/Dockerfile:runtime |
| Worker | ghcr.io/joodlab/logbird-worker | apps/worker/Dockerfile:runtime |
| Console | ghcr.io/joodlab/logbird-app | apps/app/Dockerfile:runtime |
| Migrations | ghcr.io/joodlab/logbird-migrate | apps/server/Dockerfile:migrate |

Each receives X.Y.Z, X.Y and latest tags, OCI source/version/revision/MIT license
labels, an SBOM and maximum-mode BuildKit provenance. X.Y and latest are moving
aliases; pin exact versions or digests for controlled upgrades. Only publish
releases in increasing version order, since older tags would move these aliases
backwards. Never rebuild a completed published release under the same version.

Preflight also rejects a tag that already has a GitHub Release, preserving a
completed publication on full-workflow retries. Only after all four pushes succeed
does the workflow create the GitHub Release and attach `images.txt` with all four
index digests. Notes contain the reviewed
Highlights, conventional-type groups in a collapsible changelog with PR/commit
links, and a thank-you section. Human authors and co-authors are deduplicated by
GitHub handle across email aliases; people absent before the baseline are marked
first-time contributors. Unresolved humans use names without fabricated mentions.
GitHub Bot accounts, [bot] identities, known automation addresses and AI noreply
identities are excluded from contributor credit and human-authored change counts.
Non-conventional commits remain in Other changes rather than silently disappearing.

`changelogithub.config.ts` maps `feat` → Features, `fix` → Bug fixes, `perf` →
Performance, `refactor` → Refactoring, `docs` → Documentation, `build` → Build,
`ci` → CI, `test` → Tests, `chore` → Maintenance and `revert` → Reverts (`style` →
Style). The squash-merge PR title is the commit subject and changelog line; use
scopes such as `server` or `sdk`. Within a section, entries are grouped under their
scopes once any scope there has more than one entry. A `!` before the colon, or a
`BREAKING CHANGE:` footer in the message's final paragraph, puts the change in its
own Breaking changes section. A subject with an unknown or malformed type is kept
whole: under Other changes, or under Breaking changes when it has a `!`. `@` in a
subject is defused so it never mentions an account; changelogithub still turns
`#123` into an issue link and `:emoji:` codes into emoji. CRLF messages are
normalized first. Run notes from anywhere in the repository: explicit `--changelog`/`--output`
paths are relative to where you run it, and the script always loads the root
`changelogithub.config.ts` and, by default, the root `CHANGELOG.md`.

The wrapper retains the stricter contributor policy because changelogithub's
native name-only bot filter does not cover AI email/login identities. Git itself
parses each commit's trailer block (`%(trailers:key=Co-authored-by)`, the rules of
`git interpret-trailers`), so a co-author named in prose or a fenced example is
never credited. Every identity is trimmed, then it and its GitHub login and account
type are checked against one set of rules:
- `[bot]` names and Bot accounts, and any resolved account GitHub doesn't report
  as a User (Copilot's agent login has no profile and is never credited);
- release and dependency automation whatever its account type (semantic-release,
  Renovate, Greenkeeper, Snyk, ImgBot, Mergify, all-contributors, pre-commit.ci,
  release-please, GitHub's web-flow), and any name, login or address local part
  with `bot` as a whole word (`release-bot`, `Release Bot`, `ci.bot@`). This also
  skips a real person whose surname is Bot; that trade-off is deliberate;
- known automation and AI logins and noreply addresses (Dependabot, GitHub
  Actions, Codex, Claude, Copilot, Cursor, Devin, Gemini Code Assist, Jules, Amp,
  OpenHands);
- agent mailboxes on any domain, such as `claude@`, `codex@` or `cursor-agent@`
  (a person who really uses such a mailbox should commit under another address,
  mapped to their identity with `.mailmap`);
- every address at, or under, openai.com, anthropic.com, cursor.com,
  githubcopilot.com, aider.chat, ampcode.com, all-hands.dev, codeium.com,
  windsurf.com and augmentcode.com, so employees committing from those domains
  are not credited either;
- Gemini/Jules addresses at google.com;
- agent display names such as "Claude Opus 5.5", "Cursor Agent" or "Gemini CLI",
  except for a person GitHub resolves to a User account;
- names that sanitize to nothing;
- reserved placeholder domains: `example.com`, `example.net`, `example.org`
  and the `.example`, `.test`, `.invalid` and `localhost` domains, with any
  subdomain.

The list names known agents: an agent with an unknown address and name would be
credited, so extend the rules (and their tests) when a new one appears. Identities
merge only by a verified GitHub login or by the repository's `.mailmap`, which
also applies to co-author trailers (`git check-mailmap`); two people who share a
display name are never merged. Someone who commits under an address GitHub can't
map should add a `.mailmap` line pointing it at their canonical identity; GitHub
logins are still looked up by the address each commit was made with. Both the
identity as committed (with its own GitHub login and account type) and its
`.mailmap` identity must pass the rules above, so a `.mailmap` line can never turn
an agent's or a Bot account's commits or trailers into human credit, and an alias
lends its login to a canonical address only when it is a User account. Exclusions apply to inline
credits, contributor totals and thank-you entries. Missing/truncated identity
responses or an excluded identity reaching rendering abort notes generation before
any notes are emitted. Invalid Highlights or failed preflight likewise prevent
image publishing and release creation. Fix the cause and rerun; do not bypass it.

Release concurrency serializes publications. Partial image-job failure may leave
some version tags pushed without a release: inspect the run/digests, fix the cause,
and rerun against the same accepted source before announcing availability. An
existing GitHub Release blocks a full rerun in preflight; retrying only release
creation fails rather than replacing its reviewed notes. No Coolify deployment
runs automatically.

`.github/workflows/docker.yml` separately builds all four amd64 targets, plus the
marketing site image (`apps/web/Dockerfile`, fictional build arguments), on PRs
changing Dockerfiles, Compose, Docker context exclusions or the image workflows.
The site image is not a release artifact: tags publish only the four roles above,
and the hosted instance builds the site from `docker-compose.site.yml` (see
[Coolify](coolify.md#hosted-marketing-site-logbirdjoodlabcom-only)).
It has read-only repository permissions, no registry login and never pushes.
The owner explicitly authorized these PR builds and tag-driven publication.

## First publication: make GHCR packages public

GitHub initially creates container packages as private, even for a public source
repository. After the first successful image publication, an organization owner
must open each of the four packages under the organization's Packages page,
choose Package settings, then Change visibility, then Public, and confirm. Keep each
package linked to this repository and grant its Actions workflow package write
access if an existing package does not inherit it. Do not paste tokens into logs.
See GitHub's [container registry guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
and [package access settings](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

From a host without registry credentials, pull the exact release version of all
four roles and compare the manifest digests with images.txt before announcing
anonymous self-host availability. Public repository visibility alone is not proof
of public packages. Configure Coolify with that exact LOGBIRD_VERSION; no build
steps are needed in the default Compose file. See [Coolify](coolify.md).

## Local architecture checks

Dockerfiles and dependencies use multi-platform index digests. Keep pin updates
aligned across both Compose files. With Buildx, build without publishing:

```sh
docker buildx build --platform linux/amd64 --load -f apps/server/Dockerfile --target runtime -t logbird-check/server:amd64 .
docker buildx build --platform linux/amd64 --load -f apps/worker/Dockerfile --target runtime -t logbird-check/worker:amd64 .
docker buildx build --platform linux/amd64 --load -f apps/app/Dockerfile --target runtime -t logbird-check/app:amd64 .
docker buildx build --platform linux/amd64 --load -f apps/server/Dockerfile --target migrate -t logbird-check/migrate:amd64 .
```

Repeat with linux/arm64 and :arm64, preferably on a native host. A base image's
arm64 manifest or an emulated build does not prove application acceptance there.
Check each runtime's non-root UID, readiness, migrations and worker health.
Record source SHA, toolchain, image IDs/sizes, architecture and backup/restore
receipts. Validate Compose using private env files, or fictional simulated values:

```sh
docker compose --env-file .env.selfhost-test -f docker-compose.yml config -q
docker compose --env-file .env.coolify-test -f docker-compose.coolify.yml config -q
```

A local Coolify simulation cannot prove provider secret generation, proxy routing
or live recovery. Do not reset shared databases or rotate existing keys. Source
builds remain available through docker-compose.build.yml; see
[the source installation path](self-hosting.md#build-from-source).

### Migration cancellation check

The migrate image uses `tini -g` as PID 1 to forward termination to the active
shell, pnpm and migration process group. Live cancellation/retry verification is
still pending in [#77](https://github.com/joodlab/logbird/issues/77).

Test only in a fresh disposable stack, with no shared or customer database:

1. With enough free RAM/disk, build the new migrate image and start only its
   disposable data services. Keep app/server/worker stopped.
2. Create `.tmp/migration-cancel/migration.sql` containing only
   `SELECT pg_sleep(60);`. In a temporary Compose override, mount that directory
   read-only into the migrate service at
   `/workspace/packages/database/prisma/migrations/20991231000000_qa_cancel`.
   This supplies a deliberately slow, schema-free QA migration without changing
   the image or committing a test migration. Save the override as
   `.tmp/compose.migration-cancel.yml`:

   ```yaml
   services:
     migrate:
       build: !reset null
       pull_policy: never
       volumes:
         - ./.tmp/migration-cancel:/workspace/packages/database/prisma/migrations/20991231000000_qa_cancel:ro
   ```

   This override removes the build definition and requires the image already
   built in step 1. Compose `run` has no `--no-build` flag; removing `build` and
   setting `pull_policy: never` prevents an implicit rebuild or registry pull.
   Compose v2.24.4's `run` has no `--pull` flag either: on that version drop
   `--pull never` from the commands below; the override alone fails with
   `No such image` when the image is missing.

3. With that override, run the real migration command in the background:
   `docker compose --env-file .env.selfhost-test -p logbird-selfhost-test -f docker-compose.yml -f .tmp/compose.migration-cancel.yml run --pull never -d --no-deps --name logbird-migration-cancel-probe migrate`.
   Confirm the sleep query is active in `pg_stat_activity` before cancelling;
   an already completed migration does not test signal forwarding.

   ```sql
   SELECT pid, state, query FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid()
     AND state = 'active' AND query LIKE '%pg_sleep(60)%';
   ```

4. Run `docker top logbird-migration-cancel-probe` to record the child processes,
   then `docker stop --time 20 logbird-migration-cancel-probe`. Record elapsed
   time, `docker inspect --format '{{json .State}}' logbird-migration-cancel-probe`
   and migration logs. Require exit before forced SIGKILL, exit code other than
   137, no OOM, no surviving migration children and no active QA sleep query.
   Do not count a completed command or a forced kill as a passing cancellation.
5. Inspect `_prisma_migrations` and database state. If the QA migration is marked
   failed, verify its sole sleep statement made no schema/data changes, then
   use a one-shot migrate container with the same override:
   `docker compose --env-file .env.selfhost-test -p logbird-selfhost-test -f docker-compose.yml -f .tmp/compose.migration-cancel.yml run --pull never --rm --no-deps migrate pnpm --filter @logbird/database exec prisma migrate resolve --rolled-back 20991231000000_qa_cancel`.
   This resolution is only for the schema-free QA fixture. Real failed migrations
   require inspection and an appropriate recovery decision before retry.
6. Run the default migrate command again with the override and let it finish.
   Require PostgreSQL/ClickHouse migration and query-user provisioning success;
   run it once more to verify no pending migrations. Remove the stopped probe
   container, stop/remove the disposable stack and volumes, and remove only the
   temporary fixture/override. Preserve the logs and exit-state evidence.
