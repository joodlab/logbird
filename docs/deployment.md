# First production test

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

Set APP_URL=https://audit.example.com and TRUST_PROXY=true only if the server is reachable solely through trusted ingress. With exactly one trusted proxy in front (e.g. Caddy), the server uses the rightmost `X-Forwarded-For` entry, which that proxy appends. Do not expose the API directly. The app's API proxy target is baked at build time; rebuild when changing it. Development Vite proxies are absent from the production listener.

## Acceptance

Record git SHA, image IDs, configuration key names (never values), migration output and backup receipt. Verify /livez (process), /health (legacy storage check), /readyz (Postgres/ClickHouse/Redis) directly inside the API network. Check worker.ready and an actual RetentionRun. The console listener must render login and proxy /api and /v1. Test SMTP receipt, OTP login, workspace/project creation, key creation, ingest/read, Explorer Query/SQL and rejected unauthorized queries with fictional data.

```sh
BASE_URL=https://audit.example.com pnpm smoke:prod
# Supply private TRAILMARK_INGEST_KEY and TRAILMARK_READ_KEY to test event readback.
# SMOKE_COOKIE + SMOKE_PROJECT_ID enables console Query/SQL assertions.
# SMOKE_EMAIL sends an OTP; SMOKE_OTP optionally verifies it.
```

The smoke script reports skipped optional checks explicitly. Capture their real results before declaring acceptance. Shared request limits are 30 auth requests/minute and 600 public API requests/minute per peer; invite routes use 30/minute per peer and route. Redis failures return 503. Keep ingress client-IP handling correct to avoid grouping every browser under the proxy address. Verify security headers, cookie Secure/HttpOnly/SameSite, disallowed CORS and rate limits. Kill/restart each app and test recovery. Stop writes before a rollback; use matched backups if migrations are incompatible.

ClickHouse capacity depends on event size, cardinality, retention and concurrent scans. Measure compressed disk growth using fictional representative traffic, reserve free disk for merges/backups, and keep query memory limits below available RAM. Alert on disk pressure, /readyz failures, HTTP 5xx/429, queue age, failed retention and backup age. Logs contain event names, request IDs, status and timing; do not collect bodies, cookies, API keys or raw URLs with query parameters. This single VM is a first test, not HA.
