---
title: Self-host Logbird
description: Run Logbird on your own server with Docker Compose or Coolify. Bring your own Postgres, ClickHouse and Redis, add TLS, back it up.
path: /self-hosting
---

# Self-hosting

> **Published images (since 0.1.0).** With `WEB_GITHUB_PUBLIC=true` the quickstart clones the latest release tag and
> runs `docker compose pull` + `docker compose up -d --no-build` (`apps/web/src/lib/selfhost.ts`, checked against
> docs/self-hosting.md); the version comes from the published release list. Building from source is linked, not shown.
> "Published images" is no longer in "Not there yet". Coolify note: "Upgrades and restores through Coolify are
> documented but not yet verified end to end."

## hero

- **id:** `hero`
- **eyebrow:** Self-hosting
- **heading (H1):** Your audit log, on your servers.
- **body:** Logbird is MIT-licensed and self-hosts with Docker Compose. Run it on one VM and your events stay on your
  own servers. It's the same codebase Logbird Cloud will run.
  <!-- source: LICENSE; docs/SPEC.md intro ("one codebase, self-host or cloud") -->
- **cta:** Quickstart ↓ `#quickstart` (public repo only) · Join the Cloud waitlist → `/contact`
- **small print:** Compose pulls the published `<latest release>` images for amd64 and arm64 from GHCR.
  <!-- private build: "Source on GitHub — coming soon."; no release yet: "Nothing has been released yet." -->
- **visual:** a diagram of the Compose stack (console, api, worker, postgres, clickhouse, redis). The 2026-11-05
  self-hosting captures show the old name and a real key prefix, so they aren't used.

## quickstart

- **id:** `quickstart`
- **eyebrow:** Quickstart
- **heading:** From clone to your first event.
- **body:** You need Docker Engine and Docker Compose 2.24.4 or newer. Compose pulls the four published Logbird role images; nothing
  is compiled on your server. <!-- source: docs/self-hosting.md §Five-minute quickstart -->
- **code sample (rendered only when `WEB_GITHUB_PUBLIC=true` and the release list has a release; while the repository
  is private the section reads "The quickstart is published when the repository opens." with the self-host CTA — see
  `README.md` § Self-host CTA rule; in a public build with no release it reads "Nothing has been released yet." and links
  to the guide's "Build from source"):**

  ```sh
  git clone --branch v<latest release> <repository URL>.git logbird
  cd logbird
  sh scripts/selfhost-init.sh   # creates .env and generates secrets
  # Set SMTP in .env, or AUTH_LOG_SIGN_IN_CODES=true for a first local test.
  # Internet-facing? Also set AUTH_SIGNUP=restricted and AUTH_SIGNUP_DOMAINS.
  docker compose pull
  docker compose up -d --no-build
  ```
  <!-- source: apps/web/src/lib/selfhost.ts; docs/self-hosting.md §Five-minute quickstart -->

- **steps after the code:**
  1. Open `http://localhost:4600` and sign in with the code sent to your email, or printed in the server log if you set
     `AUTH_LOG_SIGN_IN_CODES=true`.
  2. Create a workspace and a project. Copy the ingest key; it's shown once.
  3. Set LOGBIRD_INGEST_KEY to the key you just copied, and send an event with the request on the right.

     ```sh
     curl http://localhost:4600/v1/events \
       -H "Authorization: Bearer $LOGBIRD_INGEST_KEY" \
       -H 'Content-Type: application/json' \
       -d '{"action":"document.updated"}'
     ```

  4. Expect `202`, and the event in the explorer.
- **bullets:**
  - The init script generates the secrets it needs and never overwrites values you've set.
  - Need unreleased code or a custom build? The self-hosting guide covers building from source, every setting, TLS,
    backups and restores.
  - `/livez` checks the API process; `/readyz` checks Postgres, ClickHouse and Redis.
- **visual:** none. The quickstart code renders only once `WEB_GITHUB_PUBLIC=true`; until then a "published when the
  repository opens" panel.

## requirements

- **id:** `requirements`
- **eyebrow:** Requirements
- **heading:** What you need.
- **bullets:**
  - A Linux host, or any machine that runs Linux containers, with Docker Engine and Compose 2.24.4 or newer.
  - An SMTP provider for sign-in codes and invitations, for example Amazon SES, Postmark or Brevo.
  - A domain and ports 80 and 443 if you want automatic HTTPS.
  - **Starting size:** 4 vCPU, 8 GB RAM and SSD storage. That is an initial allocation, not measured capacity. Leave disk
    for images as well as your data, ClickHouse merges and backups; building from source needs more headroom still.
  - **Access:** Sign-up is open by default: anyone who can reach the console can create an account. On an
    internet-facing instance, set `AUTH_SIGNUP=restricted` with your email domains; invitations keep working.
  <!-- source: docs/self-hosting.md §SMTP and first login, §Caddy TLS, §Sizing, §Five-minute quickstart (after #51) -->
- **visual:** diagram: the architecture at a glance (moved from home), from `apps/web/src/content/architecture.ts`.
  <!-- source: README.md §Architecture; docs/SPEC.md §2, §4 -->

## options

- **id:** `options`
- **eyebrow:** Ways to run it
- **heading:** Pick the setup that fits what you already run.
- **cards:**
  1. **Bundled Compose.** One Compose project runs Postgres, ClickHouse, Redis, the API, the worker and the
     console. Only the console port is published, on `127.0.0.1` by default. A one-off migration step runs before
     the API and worker start.
     <!-- source: docs/self-hosting.md; docs/deployment.md -->
  2. **Coolify.** Point Coolify's Docker Compose build pack at `docker-compose.coolify.yml`. Coolify generates the
     secrets, pulls the published images and routes your domain to the console. <!-- no release yet: "builds the images
     once you add docker-compose.build.yml (see the Coolify guide)" -->
     <!-- source: docs/coolify.md -->
  3. **Bring your own databases.** Use your own Postgres, ClickHouse and Redis (or Dragonfly) with
     `docker-compose.external.yml`. Use ClickHouse 26.9. Logbird creates its own restricted query user
     and row policies.
     <!-- source: docs/self-hosting.md §External services -->
- **limit line:** Step by step in the Coolify guide. Upgrades and restores through Coolify are documented but not yet
  verified end to end. <!-- source: docs/coolify.md §Sources and validation limits -->
- **visual:** diagram: three cards side by side, each a small stack. "Bundled": a box labelled `docker compose` holding
  console, API, worker, Postgres, ClickHouse, Redis. "Coolify": the same stack under a Coolify proxy. "External": the
  console, API and worker in Compose, with arrows out to three external databases.

## tls

- **id:** `tls`
- **eyebrow:** HTTPS
- **heading:** Automatic HTTPS, or the proxy you already run.
- **body:** Set your domain in `.env` and run `docker compose --profile tls up -d`. Caddy gets and renews the
  certificate. Already run Nginx, Traefik or another proxy? Forward the whole origin to port 4600 and tell Logbird how
  many proxies sit in front, so rate limits and audit context see the real client address.
  <!-- source: docs/self-hosting.md §Caddy TLS, §Any reverse proxy -->
- **code sample:**

  ```sh
  # .env
  APP_URL=https://audit.example.com
  LOGBIRD_DOMAIN=audit.example.com
  TRUST_PROXY=2
  ```

- **limit line:** Never expose the API server's own port. Everything goes through the console origin.
- **visual:** code sample

## smtp

- **id:** `smtp`
- **eyebrow:** Email
- **heading:** Sign-in is by emailed code.
- **body:** Logbird has no passwords. People sign in with a one-time code sent by email, so configure an SMTP
  provider. For a first local test you can log sign-in codes to the server log instead. Turn that off once SMTP
  works: anyone who can read the logs can sign in.
  <!-- source: docs/self-hosting.md §SMTP and first login -->
- **visual:** none.

## upgrades

- **id:** `upgrades`
- **eyebrow:** Upgrades and backups
- **heading:** Upgrade to a pinned release, after a backup.
- **steps:**
  1. **Stop writes.** Run every command in these steps with the installation's own Compose project, env file, `-f` files
     and profile (after a restore cutover, the restored project's). Block ingress and stop the console, server and worker. The worker gets five minutes to finish its
     current job: wait for the stop to complete, and check its logs if it had to be killed.
  2. **Back up.** With writers stopped: matched Postgres (`pg_dump`) and ClickHouse (`BACKUP DATABASE`) backups and a
     SHA-256 checksum file. Keep the original env file; record the Git revision (`git rev-parse HEAD`) and the images
     (`docker compose images`).
  3. **Pin the new version.** Check out the release tag `vX.Y.Z`, then set `LOGBIRD_VERSION=X.Y.Z`, without the `v`, in
     the env file the installation runs with (`.env`, or the one you cut over to after a restore): its value overrides
     the Compose default, and a `LOGBIRD_VERSION` or `LOGBIRD_IMAGE_REGISTRY` exported in your shell overrides the env
     file (unset it). Run `docker compose config --images` and check the full names: all four must be
     `<registry>/logbird-<role>:X.Y.Z`, with the registry you expect (the project's GHCR namespace by default). Built from source
     (`docker-compose.build.yml`)? Keep that override and build the four roles from the new revision instead; the image
     check doesn't apply.
  4. `docker compose pull` (skip it for a source build), then `docker compose up -d --no-build`. Migrations run first; if one fails, the new
     version doesn't start.
  5. **Verify.** Readiness, sign-in, your events, settings and keys, and the retention runs, before you reopen ingress.
- **bullets:**
  - `docker compose down` keeps your data. `docker compose down -v` permanently deletes the Compose-managed volumes,
    which hold the bundled Postgres, ClickHouse and Redis data.
  - Restore into empty, separate storage first, and check counts before you switch over.
  <!-- source: docs/self-hosting.md §Upgrades and backups -->
<!-- planned call to action, not on the page yet: Full self-hosting guide → docs/self-hosting.md -->
- **visual:** none

## not-yet

- **id:** `not-yet`
- **eyebrow:** Not there yet
- **heading:** What self-hosting doesn't include today.
- **bullets:**
  - **High availability.** The Compose setup is a single VM. It has no failover.
  - **Production sizing guarantee.** There's no published sizing guarantee yet. Size from your own measurements.
  - **SSO.** Sign-in is by emailed code only. SSO is on the roadmap.
  <!-- source: docs/self-hosting.md; docs/deployment.md ("This single VM is a first test, not HA"); docs/roadmap.md P2-5 -->
- **visual:** none

## final-cta

- **id:** `final-cta`
- **heading:** Rather not run it yourself?
- **body:** Logbird Cloud will run the same codebase for you. It isn't open yet.
- **cta:** Join the waitlist → `/contact`
- **visual:** none
