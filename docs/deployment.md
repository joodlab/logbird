# First production test

For the hosted-cloud architecture decision, Kubernetes manifests and release gates, see
[cloud operations](cloud-operations.md). Recovery procedures live in
[backup and disaster recovery](backup-disaster-recovery.md); operational monitoring and sender setup
are in [alerts and status](alerts-status.md) and [transactional email](transactional-email.md).
These are preparation artifacts; they do not establish a deployed or accepted cloud service.

Target: one Linux VM with Compose, private database network, SSD storage and a TLS reverse proxy. No cloud deployment or public signup is assumed. Follow [self-hosting](self-hosting.md) for builds, migrations and backups. Do not put real customer events into this first acceptance run.

## Owner decisions

Choose the domain, VM provider/region and capacity budget, SMTP provider/from address with SPF/DKIM/DMARC, security disclosure contact, cloud signup URL, backup destination/retention, recovery objectives and monitoring destination. No paid infrastructure is provisioned by this setup.

## TLS example

Install Caddy on the VM with DNS pointing to it, allow inbound 80/443, and use:

```caddyfile
audit.example.com {
  header Strict-Transport-Security "max-age=31536000"
  header X-Content-Type-Options "nosniff"
  header Referrer-Policy "strict-origin-when-cross-origin"
  reverse_proxy 127.0.0.1:4600
}
```

Set APP_URL=https://audit.example.com and TRUST_PROXY=2: Caddy and the console each append one X-Forwarded-For entry, and the server reads the entry written by the outermost trusted proxy (see [self-hosting](self-hosting.md#any-reverse-proxy)). Do not expose the API directly. The app reads LOGBIRD_SERVER_URL at runtime (default http://server:4601); recreate the app container when changing it. Development Vite proxies are absent from the production listener.

## Acceptance

Record git SHA, image IDs, configuration key names (never values), migration output and backup receipt. Verify /livez (process), /health (legacy storage check), /readyz (Postgres/ClickHouse/Redis) directly inside the API network. Check worker.ready and an actual RetentionRun. The console listener must render login and proxy /api and /v1. Test SMTP receipt, OTP login, workspace/project creation, key creation, ingest/read, Explorer Query/SQL and rejected unauthorized queries with fictional data.

```sh
BASE_URL=https://audit.example.com pnpm smoke:prod
# Supply private LOGBIRD_INGEST_KEY and LOGBIRD_READ_KEY to test event readback.
# SMOKE_COOKIE + SMOKE_PROJECT_ID enables console Query/SQL assertions.
# SMOKE_EMAIL sends an OTP; SMOKE_OTP optionally verifies it.
```

The smoke script reports skipped optional checks explicitly. Capture their real results before declaring acceptance. Shared request limits are 30 auth requests/minute per peer, 3000 ingest requests/minute per project
and 1200 read requests/minute per project (shared across keys of each kind and replicas).
`PUBLIC_RATE_LIMIT_PER_MINUTE` (600) limits failed public authentication per peer only; valid keys
remain usable behind a throttled NAT. Malformed/wrong-kind credentials can be rejected before lookup;
well-formed unknown/revoked credentials still require lookup to distinguish them from valid keys.
Configure `AUTH_RATE_LIMIT_PER_MINUTE`, `PUBLIC_RATE_LIMIT_PER_MINUTE`,
`INGEST_RATE_LIMIT_PER_MINUTE` and `READ_RATE_LIMIT_PER_MINUTE`. Invite routes retain 30/minute
per peer and route. Redis failure is closed for auth/invites (503 rate_limit_unavailable), open
for public ingest/read; alert on `rate_limit.storage_error`. Authenticated public responses carry
`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds until reset); 429 includes `Retry-After`.
Keep ingress client-IP handling correct to avoid grouping every browser under the proxy address. Verify security headers, cookie Secure/HttpOnly/SameSite, disallowed CORS and rate limits. Kill/restart each app and test recovery. Stop writes before a rollback; use matched backups if migrations are incompatible.

ClickHouse capacity depends on event size, cardinality, retention and concurrent scans. Measure compressed disk growth using fictional representative traffic, reserve free disk for merges/backups, and keep query memory limits below available RAM. Alert on disk pressure, /readyz failures, HTTP 5xx/429, queue age, failed retention and backup age. Logs contain event names, request IDs, status and timing; do not collect bodies, cookies, API keys or raw URLs with query parameters. This single VM is a first test, not HA.

Compose gates server/worker on a one-shot migrate service. See [self-hosting](self-hosting.md) for the Caddy profile, backup/restore, external services and SMTP/log-code setup, and [Coolify](coolify.md) for Git-based builds. Images are not published; no CI Docker builds are configured.
