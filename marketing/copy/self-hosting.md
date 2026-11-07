---
title: Self-host Logbird
description: Run Logbird on your own server with Docker Compose or Coolify. Bring your own Postgres, ClickHouse and Redis, add TLS, back it up.
path: /self-hosting
---

# Self-hosting

## hero

- **id:** `hero`
- **eyebrow:** Self-hosting
- **heading (H1):** Your audit log, on your servers.
- **body:** Logbird is MIT-licensed and self-hosts with Docker Compose. Run it on one VM and your events stay on your
  own servers. It's the same codebase Logbird Cloud will run.
  <!-- source: LICENSE; docs/SPEC.md intro ("one codebase, self-host or cloud") -->
- **cta:** Five-minute quickstart ↓ `#quickstart` · Join the Cloud waitlist → `/contact`
- **small print:** Source on GitHub — coming soon. Self-hosting builds from source; no images are published yet.
- **visual:** clip `marketing/captures/2026-11-05-self-hosting/selfhost-e2e.webm` (clean machine → `compose up` →
  sign-in → first event). Check the clip for real email addresses and hostnames before use.

## quickstart

- **id:** `quickstart`
- **eyebrow:** Quickstart
- **heading:** Five minutes to your first event.
- **body:** You need Docker Engine and Docker Compose 2.24.4 or newer. The first build takes longer, depending on
  your CPU and network. <!-- source: docs/self-hosting.md §Five-minute quickstart -->
- **code sample (rendered only once `WEB_GITHUB_PUBLIC=true`; until then the section reads "The quickstart is published
  when the repository opens." with the self-host CTA — see `README.md` § Self-host CTA rule):**

  ```sh
  git clone <WEB_GITHUB_URL>.git
  cd logbird
  sh scripts/selfhost-init.sh   # creates .env and generates secrets
  # Set SMTP in .env, or set AUTH_LOG_SIGN_IN_CODES=true for a first test.
  docker compose up -d
  ```

  Small print: "The repository opens publicly soon. Until then, this command won't work for you."
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
- **visual:** `marketing/captures/2026-11-05-self-hosting/08-curl-ingest.png`, then
  `07-first-event-received.png`. Check both for real paths or addresses before use.

## requirements

- **id:** `requirements`
- **eyebrow:** Requirements
- **heading:** What you need.
- **bullets:**
  - A Linux host, or any machine that runs Linux containers, with Docker Engine and Compose 2.24.4 or newer.
  - An SMTP provider for sign-in codes and invitations, for example Amazon SES, Postmark or Brevo.
  - A domain and ports 80 and 443 if you want automatic HTTPS.
  - **Starting size:** 4 vCPU, 8 GB RAM and SSD storage. That's an initial allocation, not measured capacity. Reserve
    disk for ClickHouse merges and backups, and measure your own growth with representative test traffic.
  <!-- source: docs/self-hosting.md §SMTP and first login, §Caddy TLS, §Sizing -->
- **visual:** none

## options

- **id:** `options`
- **eyebrow:** Ways to run it
- **heading:** Pick the setup that fits what you already run.
- **cards:**
  1. **Bundled Compose.** One `docker compose up -d` starts Postgres, ClickHouse, Redis, the API, the worker and the
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
- **visual:** `marketing/captures/2026-11-05-self-hosting/02-server-log-code.png` (code in the server log). Check for
  real addresses before use.

## upgrades

- **id:** `upgrades`
- **eyebrow:** Upgrades and backups
- **heading:** Upgrade with a pinned revision, after a backup.
- **steps:**
  1. Back up Postgres (`pg_dump`) and ClickHouse (`BACKUP DATABASE`, to a disk or S3).
  2. Stop writes and pin a tested revision.
  3. Run `docker compose up -d --build`. Migrations run first; if one fails, the new version doesn't start.
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
  - **Published images.** You build from source. Image tags come with the first release.
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
