# Releases and container images

The self-host stack uses stable SemVer tags `vMAJOR.MINOR.PATCH`. All tracked
package manifests (including the SDK, integrations and examples) share that version.
Git tags include `v`; package versions, image tags and `LOGBIRD_VERSION` omit it.
The first release is prepared as 0.1.0; the workflow must finish before its images
or GitHub Release can be treated as available.

## Choosing the version

While Logbird is below 1.0, bump the **patch** number (0.1.0 → 0.1.1 → 0.1.2) for
every release, including new features, fixes and optional new settings. Bump the
**minor** number (0.1.x → 0.2.0) only for a breaking change: something a self-hoster
or API client must act on, such as a removed or renamed setting, an API or SDK change
that breaks existing callers, or a migration that can't run unattended. Say which
it is in the release PR. A `!` or `BREAKING CHANGE:` commit since the last tag means
the next release is a minor bump.

## Prepare a release

1. Start a release PR from master. Add `## X.Y.Z` to CHANGELOG.md with one to
   three user-facing bullets under `### Highlights`. Document configuration,
   migration, recovery and known limits. Keep an empty `## Unreleased` for later work.
2. Set every tracked package.json version to X.Y.Z, including examples and SDK
   integrations, and `<VersionPrefix>` in `sdks/dotnet/Directory.Build.props` (the
   .NET packages). Run `pnpm release:version`; passing a tag additionally checks it:
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
   use the nearest preceding reachable stable `vX.Y.Z` tag, ignoring prereleases and tags listed as unpublished in `scripts/release-notes.mjs` (a tag whose release never completed, such as `v0.1.2`).
   `--from vX.Y.Z` overrides the baseline and must be an ancestor. Compare links
   use the baseline and new version; first releases link the full commit history.
   Highlights must exist in the exact version section; missing/empty/comment-only
   or more than three bullets fail closed. Preview output belongs in the release PR.

   To simulate the next release, put its version and reviewed Highlights in a
   scratch Markdown file, then use `--changelog .tmp/next-changelog.md --version
   v0.1.1 --to origin/master --from v0.1.0`. This does not edit CHANGELOG.md or tags.
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
then builds these four images on native `linux/amd64` (`ubuntu-latest`) and
`linux/arm64` (`ubuntu-24.04-arm`) runners:

| Role | Image | Dockerfile target |
| --- | --- | --- |
| API | ghcr.io/joodlab/logbird-server | apps/server/Dockerfile:runtime |
| Worker | ghcr.io/joodlab/logbird-worker | apps/worker/Dockerfile:runtime |
| Console | ghcr.io/joodlab/logbird-app | apps/app/Dockerfile:runtime |
| Migrations | ghcr.io/joodlab/logbird-migrate | apps/server/Dockerfile:migrate |

In parallel with the builds, the `npm` job packs and checks the TypeScript packages
at the release version (see [npm tarballs](#npm-tarballs-on-the-github-release)).
The image publish jobs wait for it as well as for the builds, so a failed npm check
publishes no image tag and no release.

A release publishes in three steps, and the GitHub Release is the point where a version
becomes current:

1. **Exact image indexes.** After the builds pass, a job per role reads the two digest
   artifacts and uses `docker buildx imagetools create` to publish the X.Y.Z image index,
   inspects it and fails unless it holds both linux/amd64 and linux/arm64. No moving alias
   changes here.
2. **The GitHub Release.** Once all four indexes publish, the release job requires one
   well-formed receipt per role (a missing role fails instead of shrinking `images.txt`),
   checks that each exact tag still resolves to its receipt's digest, verifies the npm
   tarballs again, and creates the release with `images.txt`, the five npm tarballs and
   their `SHA256SUMS`. It takes the "Latest release" mark only when no newer stable release
   is published. A draft for the tag, or a published release with other files, stops it; a
   published release holding exactly these files (a retry after the runner was lost) is
   accepted as this run's own, and the aliases follow.
3. **Moving aliases.** Only after the release exists does a job per role move `X.Y` and
   `latest` to the verified X.Y.Z index, after checking that X.Y.Z still points at it.
   `scripts/release-aliases.mjs` reads the published releases first: `latest` moves only
   when no newer stable release exists, and `X.Y` only when no newer X.Y.N does, so a late
   or re-run older release never moves an alias backwards.

Each platform build pushes by digest with OCI source/version/revision/MIT license
labels, an SBOM and maximum-mode BuildKit provenance. X.Y and latest are moving
aliases; pin exact versions or digests for controlled upgrades. Publish releases in
increasing version order. Never rebuild a completed published release under the same
version.

Preflight also rejects a tag that already has a GitHub Release, so a full-workflow rerun
never rebuilds a completed publication; "Re-run failed jobs" keeps the earlier preflight
and follows the recovery rules below. Notes contain the reviewed
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

Release concurrency serializes publications. GHCR and GitHub Releases are separate
services, so a release cannot be one atomic write; it can stop between its steps.
What each stop leaves, and what to do (the run's artifacts are kept for **seven days**;
use "Re-run failed jobs" within that time):

- **Before any image index publishes** (preflight, a build, the npm job): no exact image
  tag, moving alias or GitHub Release exists. Platform images that finished building may
  already be in the registry by digest, untagged. Re-run the failed jobs, or fix on master
  and release a new version.
- **An image job failed, before the GitHub Release**: the exact tags of the roles that
  succeeded exist, but nothing announces them and no alias moved. Re-run the failed jobs:
  the failed image job republishes its X.Y.Z index from the same platform digests and
  verifies it, and the release job follows.
- **Every image job succeeded, then the release job finds an exact tag missing or moved**
  ("Check the exact image tags" fails): "Re-run failed jobs" only repeats the same failure,
  because it reruns the release job against the same receipts. Instead:
  1. Confirm the version is still unannounced: the Releases page shows no release or draft
     for the tag, and `docker buildx imagetools inspect` shows `X.Y` and `latest` still on
     the previous release.
  2. Find out why the tag changed (the package's version history in GHCR; any other
     workflow or person that pushes to `ghcr.io/joodlab/logbird-<role>`), and stop that
     cause before going on.
  3. Then either re-run the affected image job: in this run, open the failed role's
     **Publish `<role>`** job and choose **Re-run this job** (not "Re-run all jobs", which
     would rebuild every image, and not "Re-run failed jobs"). It republishes that role's
     X.Y.Z index from the run's retained platform digests, writes a fresh receipt, and its
     dependent jobs (release, aliases, NuGet) run again. This works within the seven days
     the artifacts are kept. Or abandon the version: release the next patch version from
     master, and leave the unannounced X.Y.Z tags (or delete them in GHCR).
- **During release creation**: `gh` uploads to a draft and publishes it only when every
  upload succeeds, deleting the draft itself if an upload fails. A runner lost mid-upload
  can leave a draft behind, and the release job refuses to continue while the tag has a
  draft. After any failed or interrupted release job, open the repository's Releases page:
  if a draft for this tag exists, delete it, then re-run the failed jobs. If the release was
  published before the runner was lost, re-run the failed jobs too: the release job accepts
  a published release only when it holds exactly this run's `images.txt` and npm files,
  byte for byte, and then lets the alias jobs run. Any other published release for the tag
  stops it; investigate rather than delete a published release. Once a version is released,
  a re-run never rewrites its exact image tags: the image jobs keep the index this run
  verified, and fail unless the release's `images.txt`, the live tag and this run's earlier
  receipt agree.
- **After the release, while moving aliases**: the release is live and some aliases may
  still point at an older version (the registry takes one tag at a time). Re-run the failed
  alias jobs. Then check each alias on its own with `docker buildx imagetools inspect`:
  - `X.Y` resolves to the newest published X.Y.N release's digest (from that release's
    `images.txt`); a late patch on an older line, such as 0.2.2 after 0.3.0, still moves
    its own `0.2`;
  - `latest` resolves to the newest published stable release's digest.
  An alias that points anywhere else belongs to the run that should have moved it: re-run
  that newer release's failed alias jobs (within its seven days), not this one's, which
  leaves it alone on purpose.
- **More than seven days later**, the digest, receipt and npm artifacts are gone and a
  re-run cannot finish. Do not rebuild under the same version: release the next patch
  version. If the stopped run never published its GitHub Release, the X.Y.Z image tags it
  wrote stay unannounced; if the release did go live, those tags are announced by it, and
  any alias it did not move stays where it was until the next release moves it.

A re-run of an older version after a newer one has shipped publishes its own exact tags
and release, moves its `X.Y` only if no newer X.Y.N is published, and never moves `latest`
or the "Latest release" mark. No Coolify deployment runs automatically.

`.github/workflows/docker.yml` separately builds all four targets on native amd64
and arm64 runners on PRs changing Dockerfiles, Compose, Docker context exclusions
or the image workflows. It checks BullMQ's MessagePack serialization in both
worker images and builds the marketing site image on amd64 (`apps/web/Dockerfile`,
fictional build arguments).
The site image is not a release artifact: tags publish only the four roles above,
and the hosted instance builds the site from `docker-compose.site.yml` (see
[Coolify](coolify.md#hosted-marketing-site-logbirdjoodlabcom-only)).
It has read-only repository permissions, no registry login and never pushes.
The owner explicitly authorized these PR builds and tag-driven publication.

## npm tarballs on the GitHub Release

The TypeScript packages are not published to npm: the npm scope and token are still
an owner decision, and no workflow can publish them. Every release attaches them to its
GitHub Release instead, so applications install an exact version from there (the recipe
is in [Install the SDK](integrating-a-backend.md#install-the-sdk)):

| Asset | Package |
| --- | --- |
| `logbird-sdk-X.Y.Z.tgz` | `@logbird/sdk` |
| `logbird-hono-X.Y.Z.tgz` | `@logbird/hono` |
| `logbird-vue-X.Y.Z.tgz` | `@logbird/vue` |
| `logbird-nuxt-X.Y.Z.tgz` | `@logbird/nuxt` |
| `logbird-tanstack-start-X.Y.Z.tgz` | `@logbird/tanstack-start` |
| `SHA256SUMS` | SHA-256 of the five tarballs, in `sha256sum --check` format |

One implementation produces them. `.github/workflows/npm-tarballs.yml` is a reusable
workflow; `npm-packages.yml` calls it on pull requests and master pushes that touch the
packages, and the release's `npm` job calls it with the release version. It:

1. installs the workspace, builds and packs the five packages with
   `scripts/npm-release-assets.mjs pack` (`pnpm pack`, which applies `publishConfig`
   and replaces `workspace:` versions as a publish would), checks the tarballs with
   `scripts/check-npm-packages.mjs` at the expected version, writes `SHA256SUMS` and
   uploads the folder as the `npm-packages` artifact;
2. installs those tarballs into outside applications: `tests/npm-consumer` (TypeScript 6
   and 7, run, API reports; Node 20 and 22; hono at the floor of its peer range, at the
   version its lockfile pins and, on pull requests and master pushes only, the latest 4.x),
   and `tests/npm-consumer-adapters`. Both compare every installed package (npm's
   `node_modules/.package-lock.json`) with their committed `package-lock.json`, version and
   integrity, and fail on any difference, with two exceptions: a top-level
   `node_modules/@logbird/<name>` that resolves to one of the supplied tarballs, and, in a
   floor or latest cell, the top-level `hono` at exactly the version that cell asks for.
   In the locked cell `hono` gets the full comparison. `tests/npm-release-install` follows the
   documented install recipes (`@logbird/sdk` alone, and with `@logbird/hono`) from a
   local stand-in for the Release URL under pnpm 10 and 12 and npm 10 and 12, reinstalls with a
   frozen lockfile, type-checks and runs under TypeScript 6, and requires an altered
   tarball to be refused;
3. verifies the artifact holds exactly the release's asset set with
   `scripts/npm-release-assets.mjs verify` and shows the `gh release create` command
   the release would run (the "Release assets (dry run)" job; its summary lists each
   asset's size and SHA-256).

The release job downloads that same artifact, runs the same verification and
`sha256sum --check`, and passes the files to `gh release create` with `images.txt`.
A tag either completes all three steps above (exact images, the GitHub Release with the
tarballs, then the aliases) or stops in one of the documented intermediate states, none of
which moves an alias before the release exists or publishes a release without its exact
image indexes and tarballs.
A pull request's run of the npm workflow shows the asset set a release of that commit
would attach.

**What gates a release.** On a tag, the npm workflow runs with `release: true`, and only
checks whose inputs the repository pins can fail it: exact Node versions (20.20.2,
22.18.0, 22.23.5, 24.22.3), the pnpm version in the root `package.json`, pnpm 12.6.0
(`tests/npm-release-install/pnpm12/package.json`), npm 12.1.0, the
workspace and consumer lockfiles, the hono floor read from `@logbird/hono`'s peer range,
the hono `tests/npm-consumer/package-lock.json` locks, and the exact registry packages of
the release install check. The **"hono latest" consumer cells run on pull requests and
master pushes only**: they resolve the newest hono 4.x, so a failure there is a signal
to raise the floor or fix a regression, not a blocked release.

**If the release's npm job fails**, no exact image tag, moving alias or GitHub Release
exists (platform images that finished building may be in the registry by digest, untagged). Read the
failing check. A registry or network error is fixed by "Re-run failed jobs" (the image
builds need the registry too). A real failure needs a fix on master and a new version;
never move the tag. For a failure after the npm job, see the recovery list under
[What the tag workflow does](#what-the-tag-workflow-does).

## NuGet packages (.NET SDK)

After the GitHub Release exists and the image aliases have moved, the `nuget` job can publish `Logbird` and
`Logbird.AspNetCore` to nuget.org at the release version. It is off until the
maintainers turn it on after the pre-publication gate; a release tag alone never
publishes a package:

- It publishes only when the Actions variable `NUGET_PUBLISH_ENABLED` is exactly
  `true` (lowercase; Settings, Secrets and variables, Actions, Variables) and the
  `NUGET_API_KEY` secret exists. The workflow reads the variable as this repository
  sees it: a repository variable, or an organization variable shared with the
  repository when no repository variable has that name. When the variable is unset or `false`, the job is
  skipped. When it is another spelling of true (such as `TRUE`), or the secret is
  missing, the job runs, ends with a notice and publishes nothing.
- It builds, runs the unit tests, packs both packages, and checks that each packed
  manifest carries the release version.
- It pushes `Logbird` first, then waits (up to an hour) until nuget.org serves that
  version, which happens after nuget.org's validation, and only then pushes
  `Logbird.AspNetCore`, which depends on it. If `Logbird` is not available in time,
  the job fails without pushing `Logbird.AspNetCore`; rerun it later.
- Packages and symbol packages are pushed separately, so a rerun completes whatever
  an earlier run left out. A package push skips a version already on nuget.org, and a
  published package version can never be replaced. A symbol package is pushed again
  on every rerun: nuget.org accepts a new symbol package for a published version
  (it refuses one only while an earlier one is still being validated), and the
  deterministic build makes it the same symbols.

The job also refuses to publish a version that could break the last published one unseen. Before packing, it asks
nuget.org for the latest version of each package published before the release version, and fails when one exists and
`PackageValidationBaselineVersion` (`sdks/dotnet/Directory.Build.props`) is unset or older than it. Before the first
publication it passes with a notice. Versions at or above the release version are ignored, so rerunning a release that
pushed one package but not the other still passes. Package validation then compares the new packages with that version and fails on
any breaking change. See `sdks/dotnet/CONTRIBUTING.md` for what each check catches.

In the release that publishes a version to nuget.org, also:

1. Move every line of each package's `PublicAPI.Unshipped.txt` into its `PublicAPI.Shipped.txt`
   (`sdks/dotnet/src/Logbird/` and `sdks/dotnet/src/Logbird.AspNetCore/`), leaving only `#nullable enable` in
   `Unshipped`, so the published surface is the shipped record. A `*REMOVED*` line is not moved: delete it together
   with the Shipped line it names.
2. In the next release after it, set `PackageValidationBaselineVersion` to the version just published.

Before the first publication, an owner:

1. Asks nuget.org to reserve the `Logbird` ID prefix for the publishing account, so
   it covers both `Logbird` and `Logbird.AspNetCore` (and any later `Logbird.*` package).
2. Creates an API key with the push scope and the glob pattern `Logbird*`. A pattern
   of `Logbird.*` would not match the `Logbird` package itself.
3. Stores the key as the `NUGET_API_KEY` secret and sets `NUGET_PUBLISH_ENABLED=true`.

To stop publishing, set the repository variable `NUGET_PUBLISH_ENABLED` to `false`. A
repository variable takes precedence over an organization variable of the same name, so
this turns publishing off even if the organization defines it; removing the repository
variable is enough only when the organization does not.

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
