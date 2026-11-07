# Logbird on Coolify

Use the Git repository Docker Compose build pack. No images are published yet; Coolify builds from source. The committed file publishes no host ports. Only app:4600 should receive a public domain.

1. Open Projects, choose the project/environment, then New Resource (some versions show + New).
2. Choose Git repository. For this private repository use your authorized private GitHub App installation, or a deploy key. Select joodlab/logbird, a pinned branch/revision and destination server.
3. Select Docker Compose build pack / Compose build strategy. Set Base Directory `/` and Docker Compose Location `/docker-compose.coolify.yml`. Save, load and review Compose content.
4. Under Domains, assign app `https://audit.example.com:4600`. The suffix selects the internal listener; visitors use ordinary HTTPS. Do not assign domains to data services, server, migrate or worker.
5. In Environment Variables, confirm SERVICE_URL_APP_4600 represents the public console URL with scheme. Set APP_URL explicitly to `https://audit.example.com` if necessary; the definition defaults it to SERVICE_URL_APP_4600. SERVICE_FQDN_APP_4600 contains a hostname without scheme and cannot be APP_URL.
6. Confirm generated SERVICE_PASSWORD_64_POSTGRES, SERVICE_PASSWORD_64_CLICKHOUSE, SERVICE_HEX_64_QUERY and SERVICE_PASSWORD_64_AUTH. Reuse identical names across services; never regenerate on redeploy. Query password must be exactly 64 lowercase hex characters. Configure SMTP_* and MAIL_FROM, or explicitly enable AUTH_LOG_SIGN_IN_CODES=true temporarily. Keep the default TRUST_PROXY=2 (Coolify's proxy plus the console) while the API stays private. Leave database URL overrides empty for bundled services.
7. Deploy and inspect Deployment Logs: data services become healthy, migrate exits successfully, API becomes healthy, then worker/app start. Correct migration failures before continuing. Check Runtime Logs for unhealthy services.
8. Open the console, request the code, sign in, create workspace/project, and send the [quickstart curl](self-hosting.md). Check /readyz publicly. Disable code logging and redeploy once SMTP works.
9. Upgrades: block ingress and stop writers, take matched backups, pin a tested revision, redeploy, then verify login, event readback, readiness and worker receipts before reopening ingress. Preserve volumes and generated credentials; do not delete storage to fix an upgrade.

The dependency images are pinned by multi-platform digest, matching the ordinary
Compose stack. Keep both files aligned when updating those pins. Use the native
[backup/restore procedure](self-hosting.md#native-backup-and-fresh-storage-restore)
with the same stopped-writer boundary. This file mounts `config/clickhouse-backups.xml`
into ClickHouse, enabling the named `backups` disk without a second Compose file.

This guide does **not support a data-only restore through the Coolify UI**. A normal
deployment includes migrate; do not deploy an empty recovery target and then copy
database archives into it. Use the standalone, empty Compose recovery project in
the linked procedure, normalize and pass its recovery/cutover gates first. Handing
that restored installation back to Coolify, a data-only UI workflow and provider
backup/restore behavior remain unverified in [#77](https://github.com/joodlab/logbird/issues/77).
An experienced destination-host operator may manage data-only containers outside
the UI, but this guide does not establish that workflow or authorize changing a
running resource's generated project/volume identities.

A local Compose simulation cannot validate Coolify's secret generator or reverse
proxy. The [manual release guide](releases.md) records
the separate publication/architecture gates; no automatic Docker builds are added.

The file uses documented Compose interpolation, nested `${APP_URL:-${SERVICE_URL_APP_4600:?}}`, and required-value operators. Magic credential identifiers are single tokens: POSTGRES, CLICKHOUSE, QUERY, AUTH. Extra underscores can change generator parsing; avoid names such as SERVICE_PASSWORD_DB_PASSWORD.

## Sources and validation limits

Checked official documentation on 2026-11-05 for magic names, URL/FQDN semantics, port suffixes, nested defaults, persistent generated secrets and Git build-pack setup:

- [Compose knowledge base](https://coolify.io/docs/knowledge-base/docker/compose).
- [Compose build pack](https://coolify.io/docs/applications/build-packs/docker-compose), now redirecting to [the current reference](https://coolify.io/docs/applications/builds/docker-compose).

Static validation uses `docker compose --env-file .env.coolify-test -f docker-compose.coolify.yml config -q` with simulated magic values. A disposable runtime simulation is pending in #77; its local-only override will publish a loopback app port, since this file has none. Coolify itself, GitHub App access, dashboard secrets, domain routing, public ACME, hosted upgrades and recovery remain unverified. No Coolify screenshots are claimed.
