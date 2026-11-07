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

Before a maintainer creates a tag, update `CHANGELOG.md` with a dated product
version, highlights, configuration/migration actions, recovery instructions and
known limits. Keep an Unreleased section for later work. Record the exact Git SHA,
toolchain versions, base-image digests, test commands/results, image IDs/sizes,
platforms tested and backup/restore receipt. Run from a clean checkout:

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
docker buildx build --platform linux/amd64,linux/arm64 \
  --label org.opencontainers.image.revision="$REVISION" \
  --label org.opencontainers.image.version="$VERSION" \
  --tag "ghcr.io/joodlab/logbird/server:$VERSION" \
  --tag "ghcr.io/joodlab/logbird/server:sha-$REVISION" \
  --provenance=mode=max --sbom=true --push -f apps/server/Dockerfile .
```

Use the corresponding Dockerfile for app/worker and `--target migrate` for migrate.
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
