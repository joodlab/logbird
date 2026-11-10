# Logbird on Coolify

The hosted instance is planned on Coolify behind Cloudflare at `logbird.joodlab.com` after the repository is open-sourced. Provisioning and deployment remain separate steps. See the [architecture decision](decisions.md).

Use the Git repository Docker Compose build pack. The default file pulls published GHCR images; no application compilation runs on the destination. Confirm the selected version exists on the [release page](https://github.com/joodlab/logbird/releases) first. Pull/start time depends on the host and network. The committed file publishes no host ports. Only app:4600 should receive a public domain.

1. Open Projects, choose the project/environment, then New Resource (some versions show + New).
2. Choose Public Repository and enter `https://github.com/joodlab/logbird.git`. Select a pinned branch/revision and destination server. For a private fork instead, use your authorized private GitHub App installation or a deploy key.
3. Select Docker Compose build pack / Compose build strategy. Set Base Directory `/` and Docker Compose Location `/docker-compose.coolify.yml`. Save, load and review Compose content.
4. Under Domains, assign app `https://audit.example.com:4600`. The suffix selects the internal listener; visitors use ordinary HTTPS. Do not assign domains to data services, server, migrate or worker.
5. In Environment Variables, confirm SERVICE_URL_APP_4600 represents the public console URL with scheme. Set APP_URL explicitly to `https://audit.example.com` if necessary; the definition defaults it to SERVICE_URL_APP_4600. SERVICE_FQDN_APP_4600 contains a hostname without scheme and cannot be APP_URL.
6. Confirm generated SERVICE_PASSWORD_64_POSTGRES, SERVICE_PASSWORD_64_CLICKHOUSE, SERVICE_HEX_64_QUERY and SERVICE_PASSWORD_64_AUTH. Reuse identical names across services; never regenerate on redeploy. Query password must be exactly 64 lowercase hex characters. Configure SMTP_* and MAIL_FROM (for Postmark on 587 set SMTP_REQUIRE_TLS=true; see [SMTP](self-hosting.md#smtp-and-first-login)), or explicitly enable AUTH_LOG_SIGN_IN_CODES=true temporarily. On a public instance set AUTH_SIGNUP=restricted and AUTH_SIGNUP_DOMAINS to your company domain before configuring SMTP, so strangers cannot create accounts. Keep the default TRUST_PROXY=2 (Coolify's proxy plus the console) while the API stays private. Leave database URL overrides empty for bundled services.
7. Set LOGBIRD_VERSION to `0.1.1` (or another tested release, without `v`), then deploy and inspect Deployment Logs: data services become healthy, migrate exits successfully, API becomes healthy, then worker/app start. Correct migration failures before continuing. Check Runtime Logs for unhealthy services.
8. Open the console, request the code, sign in, create workspace/project, and send the [quickstart curl](self-hosting.md). Check /readyz publicly. Disable code logging and redeploy once SMTP works.
9. Upgrades: block ingress and stop writers, take matched backups, pin the matching tested Git revision and LOGBIRD_VERSION, redeploy, then verify login, event readback, readiness and worker receipts before reopening ingress. Preserve volumes and generated credentials; do not delete storage to fix an upgrade. Coolify does not run `selfhost-init.sh`: if Environment Variables contains `LOGBIRD_IMAGE_REGISTRY=logbird` (the pre-2026-11-08 default), delete it so the default `ghcr.io/joodlab` names apply. Preserve LOGBIRD_VERSION and all generated secrets across redeploys.

The dependency images are pinned by multi-platform digest, matching the ordinary
Compose stack. Keep both files aligned when updating those pins. Use the native
[backup/restore procedure](self-hosting.md#native-backup-and-fresh-storage-restore)
with the same stopped-writer boundary. This file mounts `config/clickhouse-backups.xml`
into ClickHouse, enabling the named `backups` disk without a second Compose file.

On the destination host, find the resource's generated project with
`docker compose ls`, then translate native commands to
`docker compose -p <uuid> -f <generated-compose-file>` with its actual environment,
or use `docker exec` / `docker cp` on the recorded container names. Skip the native
`-f docker-compose.backup.yml up -d clickhouse` step: this file already mounts the
backup disk. Command translation and recovery remain unverified in #77.

All four application roles use `pull_policy: always` and contain no build section.
The migration dependency still gates the API and worker. Live Coolify upgrade
acceptance remains tracked in #77.

## Build from source

For unreleased/custom code, configure the Compose Location to load
`docker-compose.coolify.yml,docker-compose.build.yml` in that order if your Coolify
version supports multiple Compose paths. Select the exact source revision. The
override supplies builds and separate local image names. If your Coolify version
accepts only one file, merge the four service entries from the build override into
the loaded Compose content, retaining the original environment/dependencies and
magic variables. Review the resolved content before deploying. Returning to
published images means removing that override and selecting LOGBIRD_VERSION.

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
proxy. The [release guide](releases.md) describes tag-driven publication and the
separate architecture/runtime acceptance gates.

The file uses documented Compose interpolation, nested `${APP_URL:-${SERVICE_URL_APP_4600:?}}`, and required-value operators. Magic credential identifiers are single tokens: POSTGRES, CLICKHOUSE, QUERY, AUTH. Extra underscores can change generator parsing; avoid names such as SERVICE_PASSWORD_DB_PASSWORD.

## Sources and validation limits

Checked official documentation on 2026-11-05 for magic names, URL/FQDN semantics, port suffixes, nested defaults, persistent generated secrets and Git build-pack setup:

- [Compose knowledge base](https://coolify.io/docs/knowledge-base/docker/compose).
- [Compose build pack](https://coolify.io/docs/applications/build-packs/docker-compose), now redirecting to [the current reference](https://coolify.io/docs/applications/builds/docker-compose).

Static validation uses `docker compose --env-file .env.coolify-test -f docker-compose.coolify.yml config -q` with simulated magic values. A disposable runtime simulation is pending in #77; its local-only override will publish a loopback app port, since this file has none. Coolify itself, GitHub App access, dashboard secrets, domain routing, public ACME, hosted upgrades and recovery remain unverified. No Coolify screenshots are claimed.

## Hosted marketing site (logbird.joodlab.com only)

The console remains the public front door. Set `LOGBIRD_SITE_URL=http://logbird-site:4620`
to forward marketing pages, `/site-assets/`, `/site-api/`, media and discovery files
to a private site server. Anonymous `/` visits see the site; a non-empty Logbird
session cookie keeps `/` on the console. API, sign-in and invitation routes stay on
the console. Self-hosters leave `LOGBIRD_SITE_URL` empty for the existing behavior.

Create a separate Docker Compose resource using `/docker-compose.site.yml`, with
no public domain or host ports. Set its `WEB_*` build variables (the site URL is
`https://logbird.joodlab.com`, and so is `WEB_APP_URL`: the console origin, the site
links `/login` itself), SMTP settings and
`WEB_TRUST_PROXY` for the actual proxy chain. The named `/data` volume holds waitlist
submissions; preserve it across redeploys. The privacy policy and terms name the
operator from `WEB_ORG_NAME`, `WEB_PRIVACY_EMAIL`, `WEB_LEGAL_ADDRESS`,
`WEB_GOVERNING_LAW`, `WEB_HOSTING_PROVIDER`, `WEB_EMAIL_PROVIDER` and
`WEB_MAILBOX_PROVIDER`; the site stays
noindex until the publisher name and the privacy mailbox are set (see
`marketing/copy/legal-privacy.md`). Set `WEB_GOVERNING_LAW` (or a `WEB_LEGAL_ADDRESS`
that names the country) before indexing too: otherwise the terms' governing-law
clause can't be pinned to a country. The privacy policy says each form submission is
emailed to the team, and until `WEB_PRIVACY_EMAIL` exists the form is the channel
for privacy requests, so on the hosted site `SMTP_*`, `MAIL_FROM` and
`WAITLIST_NOTIFY_TO` are required, not optional: test them with one submission
after each deploy.

Set `LOGBIRD_STACK_NETWORK` to the existing Logbird Compose resource's network name,
usually its Coolify resource UUID. On the destination host, use `docker network ls`
and match the Logbird resource UUID shown in Coolify; confirm with
`docker network inspect <uuid>`. The site joins that external network as
`logbird-site`, so the console can reach it privately. Deploy the site before
setting the console's `LOGBIRD_SITE_URL` and redeploying the console.

The forwarding ships in the console image, so `LOGBIRD_SITE_URL` takes effect only
from the first release that contains it; older console images ignore the variable.
The site is not a release image: Coolify builds it from the selected revision, so
copy changes deploy without a release. Point the site resource at `master` once the
release that introduces the forwarding is live: redeploying it then picks up merged
copy changes and the latest CHANGELOG.md. The site reads the published release
list when it builds, so after each release redeploy it **without cache** (an
unchanged source would otherwise reuse the cached build and keep the old list), then
confirm `/changelog` lists the new version. A new top-level site path needs a console
release first (`apps/app/server/site-paths.ts`); until then it is a console 404.
Same origin also means shared trust: site scripts run on the console's origin, so
keep the site's strict per-page CSP.
The site joins the stack's network, so recreating the `logbird` resource (new UUID)
means updating `LOGBIRD_STACK_NETWORK` and redeploying the site. Rolling back means clearing
`LOGBIRD_SITE_URL` and redeploying the console; `/` then signs visitors in again.

After a deploy, check the shared origin with
`SHARED_ORIGIN=1 BASE_URL=https://<console origin> pnpm --filter @logbird/web check:live`:
the forwarded paths must carry the site's own security headers, and console paths
(sign-in, unknown pages) must never answer with a site page.

### Form submissions

The site keeps each contact and early-access submission in `/data/waitlist.jsonl`
for `WEB_FORM_RETENTION_MONTHS` calendar months (a build variable, default 24,
1–120): a submission sent on 31 March with one month expires on 30 April. The
privacy policy states the same period. The site deletes expired submissions itself,
when it starts and then every six hours, logging `waitlist.retention` with counts
only. The cleanup runs only in the production server with `WAITLIST_FILE` set, which
the site image does; never in `vite dev`, while a build prerenders pages, or for the
source default file. To change the period, set the variable and redeploy the site;
the policy text and the cleanup change together.

To delete one person's submissions on request, run this in the site container:

```sh
docker exec <site container> node waitlist/admin.mjs forget someone@example.com
```

It prints how many submissions it removed, never their contents. Also delete the
notification emails for that address from the team mailbox. From a source checkout,
`pnpm --filter @logbird/web waitlist:forget someone@example.com` does the same for
the `WAITLIST_FILE` in the root `.env` (default `apps/web/.data/waitlist.jsonl`).
Writes to the file (new submissions, the cleanup and this command) take one lock,
so running the command while the site serves traffic never loses a submission.

The Cloudflare build (not used by the hosted site) stores submissions in the
`WAITLIST_KV` namespace with the same lifetime as a KV expiry. Keys written before
that expiry existed have none: list them with
`wrangler kv key list --binding WAITLIST_KV --prefix waitlist:` and delete the
expired ones with `wrangler kv key delete --binding WAITLIST_KV <key>`. On request,
delete the keys whose value has that email address the same way.
