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
- **small print:** Source on GitHub — coming soon. Self-hosting builds from source; no images are published yet.
  <!-- when WEB_GITHUB_PUBLIC=true: drop "Source on GitHub — coming soon." -->
- **visual:** a diagram of the Compose stack (console, api, worker, postgres, clickhouse, redis). The 2026-11-05
  self-hosting captures show the old name and a real key prefix, so they aren't used.

## quickstart

- **id:** `quickstart`
- **eyebrow:** Quickstart
- **heading:** From clone to your first event. <!-- no time claim: source builds vary by machine -->
- **body:** You need Docker Engine and Docker Compose 2.24.4 or newer. The first build takes longer, depending on
  your CPU and network. <!-- source: docs/self-hosting.md §Five-minute quickstart -->
- **code sample (rendered only once `WEB_GITHUB_PUBLIC=true`; until then the section reads "The quickstart is published
  when the repository opens." with the self-host CTA — see `README.md` § Self-host CTA rule):**

  ```sh
  git clone <WEB_GITHUB_URL>.git
  cd logbird
  sh scripts/selfhost-init.sh   # creates .env and generates secrets
  # Set SMTP in .env, or set AUTH_LOG_SIGN_IN_CODES=true for a first test.
  # Build the four roles one at a time (less peak memory), then start without rebuilding.
  docker compose build migrate
  docker compose build server
  docker compose build worker
  docker compose build app
  docker compose up -d --no-build
  ```
  <!-- source: docs/self-hosting.md (after #51): sequential builds, pull_policy: build, up --no-build -->

- **steps after the code:**
  1. Open `http://localhost:4600` and sign in with the code sent to your email.
  2. Create a workspace and a project. Copy the ingest key; it's shown once.
  3. Send an event:

     ```sh
     curl http://localhost:4600/v1/events \
       -H "Authorization: Bearer $LOGBIRD_INGEST_KEY" \
       -H 'Content-Type: application/json' \
       -d '{"action":"document.updated"}'
     ```

  4. Expect `202`, and the event in the explorer.
- **bullets:**
  - The init script generates the secrets it needs and never overwrites values you've set.
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
  - **Starting size:** 4 vCPU, 8 GB RAM and SSD storage. That's an initial allocation, not measured capacity. Building
    from source needs more headroom: build the roles one at a time, and leave disk for images and build cache as well
    as your data, ClickHouse merges and backups.
  - **Access:** sign-up is open: anyone who can reach the console can create an account and a workspace. Keep it private
    while you evaluate, or restrict who can reach it.
  <!-- source: docs/self-hosting.md §SMTP and first login, §Caddy TLS, §Sizing, §Five-minute quickstart (after #51) -->
- **visual:** none

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
     secrets and routes your domain to the console. Builds run from source.
     <!-- source: docs/coolify.md -->
  3. **Bring your own databases.** Use your own Postgres, ClickHouse and Redis (or Dragonfly) with
     `docker-compose.external.yml`. Use ClickHouse 26.9. Logbird creates its own restricted query user
     and row policies.
     <!-- source: docs/self-hosting.md §External services -->
- **limit line:** Coolify setup is documented and checked against a local simulation. It hasn't been tested on a
  live Coolify server yet. <!-- source: docs/coolify.md §Sources and validation limits -->
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
- **heading:** Upgrade with a pinned revision, after a backup.
- **steps:**
  1. Stop writes: block ingress and stop the console, server and worker (the worker finishes its current job first).
  2. Back up, with writers stopped: matched Postgres (`pg_dump`) and ClickHouse (`BACKUP DATABASE`) backups and a
     SHA-256 checksum file. Keep the original `.env`; record the Git revision and image IDs.
  3. Switch to a tested revision.
  4. Build the four roles one at a time, then `docker compose up -d --no-build`. Migrations run first; if one fails,
     the new version doesn't start.
  5. Verify readiness, sign-in, your events, settings and keys, and the retention runs before reopening ingress.
- **bullets:**
  - `docker compose down` keeps your data. `docker compose down -v` deletes it, permanently.
  - Restore into empty, separate storage first, and check counts before you switch over.
  <!-- source: docs/self-hosting.md §Upgrades and backups -->
- **cta:** Full self-hosting guide → `docs/self-hosting.md` (repo doc; link target pending)
- **visual:** none

## not-yet

- **id:** `not-yet`
- **eyebrow:** Not there yet
- **heading:** What self-hosting doesn't include today.
- **bullets:**
  - **Published images.** You build from source; publishing to a registry is still being decided (#88). Smaller runtime
    images are in progress (#67, #68).
  - **High availability.** The Compose setup is a single VM. It has no failover.
  - **Published capacity numbers.** We haven't published load-test results yet. Size from your own measurements.
  - **SSO.** Sign-in is by emailed code only. SSO is on the roadmap.
  <!-- source: docs/self-hosting.md; docs/deployment.md ("This single VM is a first test, not HA"); docs/roadmap.md P2-5 -->
- **visual:** none

## final-cta

- **id:** `final-cta`
- **heading:** Rather not run it yourself?
- **body:** Logbird Cloud will run the same codebase for you. It isn't open yet.
- **cta:** Join the waitlist → `/contact`
- **visual:** none
