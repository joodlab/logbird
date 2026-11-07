# Manual releases and container images

No release tags or Logbird registry images have been published yet. Source builds
are the installation path. Package versions in the repository are development
metadata, not evidence of a release. No CI workflow builds or pushes Docker images;
do not add automatic image builds on pull requests or pushes.

## Version and acceptance record

Use SemVer product tags `vMAJOR.MINOR.PATCH` for the complete self-host stack. During
0.x, a minor version may require a documented migration; a patch must preserve the
documented configuration/API contract. Use `v0.1.0-rc.1`-style candidates when a
release still needs acceptance. SDK packages have independent versions and
changelog sections; they do not select container versions.

Git tags include `v`, for example `v0.1.0-rc.1`. Image `$VERSION` and
`LOGBIRD_VERSION` omit it: `0.1.0-rc.1`. The same prefix-free value is the OCI
version label; `sha-<full-sha>` remains a separate immutable image tag.

Before a maintainer creates a tag, update `CHANGELOG.md` with a dated product
version, highlights, configuration/migration actions, recovery instructions and
known limits. Keep an Unreleased section for later work. Record the exact Git SHA,
toolchain versions, base-image digests, test commands/results, image IDs/sizes,
platforms tested and backup/restore receipt. Prepare a clean source checkout with
an ignored `.env` containing valid local test configuration (including APP_URL,
auth/query credentials and service URLs); `openapi:export` explicitly loads that
file. Running Postgres, ClickHouse and Redis with the current additive schema and
restricted query user are prerequisites for complete tests. Use isolated fictional
fixtures and private queue prefixes; never reset shared data. Then run:

```sh
pnpm install --frozen-lockfile
pnpm release:check
```

Prove a fresh install, SMTP login, workspace/project/key creation, ingest/read,
restricted queries, worker retention, fresh-storage backup restore and upgrade
from the previous release with pre-existing fictional events and settings. Before
the first tag, use the previous accepted commit and state that baseline explicitly.
Preserve the original credentials. A passing image build is not application or
upgrade acceptance. Record skipped checks and blockers; do not promote a candidate
while required checks remain unverified. See [self-hosting](self-hosting.md).

## Local architecture checks

The Dockerfiles use a multi-platform Node index digest, not an amd64-only digest.
Compose dependencies are pinned by index digest too. A pin change needs a fresh
security/update review and the same runtime checks. Never assume that a base image's
arm64 manifest proves the application builds or runs on arm64.

With Docker Buildx and sufficient disk/RAM, build each role without publishing:

```sh
docker buildx build --platform linux/amd64 --load -f apps/app/Dockerfile -t logbird-check/app:amd64 .
docker buildx build --platform linux/amd64 --load -f apps/server/Dockerfile -t logbird-check/server:amd64 .
docker buildx build --platform linux/amd64 --load -f apps/server/Dockerfile --target migrate -t logbird-check/migrate:amd64 .
docker buildx build --platform linux/amd64 --load -f apps/worker/Dockerfile -t logbird-check/worker:amd64 .
```

Repeat with `linux/arm64` and `:arm64`. Prefer a native arm64 host; emulation can be
slow and does not prove native performance. Run the same Compose acceptance on
each supported architecture and inspect each role's `Config.User` plus `id -u`
(must be nonzero), readiness, migration and worker health. Record image byte sizes
with `docker image inspect`. The one-shot migrate image includes development
migration tooling and is larger than the long-running roles; its fresh final stage
excludes the build-stage package store and duplicate deployed API tree. Remove only
the test images/cache created by the run. Arm64 support remains unverified until
the application builds and acceptance passes there; list the precise failed or
unrun role/stage in the release record.

## GHCR publishing plan (maintainer action)

The proposed image names match Compose's existing naming:
`ghcr.io/joodlab/logbird/app`, `/server`, `/worker`, `/migrate`. A maintainer must
confirm package visibility and retention policy before the first publication.
Log in using an authorized package-writing credential via `--password-stdin` or a
credential helper; never commit or print it. GitHub documents authentication and
repository association in its [container registry guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

After acceptance and explicit publication approval, create the immutable Git tag
on the accepted SHA. For every role, manually build/push the tested architectures
with exact version and `sha-<full-git-sha>` tags, revision/version OCI labels,
provenance and SBOM. For example (this command publishes):

```sh
docker buildx build --platform linux/amd64 \
  --label org.opencontainers.image.revision="$REVISION" \
  --label org.opencontainers.image.version="$VERSION" \
  --tag "ghcr.io/joodlab/logbird/server:$VERSION" \
  --tag "ghcr.io/joodlab/logbird/server:sha-$REVISION" \
  --provenance=mode=max --sbom=true --push -f apps/server/Dockerfile .
```

Use the corresponding Dockerfile for app/worker and `--target migrate` for migrate.
Add `linux/arm64` to a publication only after that architecture's complete build
and application acceptance passes. The example publishes amd64 only because
arm64 is currently unverified.
Never overwrite a published version or use `latest` as an upgrade selector. Inspect
the resulting manifest/index digests, pull those images into an empty host and
rerun acceptance. Record all four registry digests in the release notes before
announcing availability. Consumers then set
`LOGBIRD_IMAGE_REGISTRY=ghcr.io/joodlab/logbird` and `LOGBIRD_VERSION=<exact-version>`
and use `docker compose up -d --no-build --pull always`. Verify the pulled digests
against the release record. Existing source-build instructions remain valid.

Publication, tag creation, package visibility and public ACME/SMTP are separate
actions from local validation. This document authorizes none of them and adds no
CI workflows. [Docker's multi-platform guide](https://docs.docker.com/build/building/multi-platform/)
describes native/emulated builders and image-store requirements.

### Migration cancellation check

The migrate image uses `tini -g` as PID 1 to forward termination to the active
shell, pnpm and migration process group. Live cancellation/retry verification is
still pending in [#77](https://github.com/joodlab/logbird/issues/77).

Test only in a fresh disposable stack, with no shared or customer database:

1. Build the new migrate image. Start only its disposable data services, using
   the resource/lock rules for the machine. Keep app/server/worker stopped.
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
       volumes:
         - ./.tmp/migration-cancel:/workspace/packages/database/prisma/migrations/20991231000000_qa_cancel:ro
   ```

3. With that override, run the real migration command in the background:
   `docker compose --env-file .env.selfhost-test -p logbird-selfhost-test -f docker-compose.yml -f .tmp/compose.migration-cancel.yml run -d --no-deps --name logbird-migration-cancel-probe migrate`.
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
   `docker compose --env-file .env.selfhost-test -p logbird-selfhost-test -f docker-compose.yml -f .tmp/compose.migration-cancel.yml run --rm --no-deps migrate pnpm --filter @logbird/database exec prisma migrate resolve --rolled-back 20991231000000_qa_cancel`.
   This resolution is only for the schema-free QA fixture. Real failed migrations
   require inspection and an appropriate recovery decision before retry.
6. Run the default migrate command again with the override and let it finish.
   Require PostgreSQL/ClickHouse migration and query-user provisioning success;
   run it once more to verify no pending migrations. Remove the stopped probe
   container, stop/remove the disposable stack and volumes, and remove only the
   temporary fixture/override. Preserve the logs and exit-state evidence.
