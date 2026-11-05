# Self-hosting

Use a Linux VM with Docker Engine and Compose v2. Start with 4 vCPU, 8 GB RAM and SSD storage for a bounded production test; this is a starting allocation, not a throughput guarantee. Pin tested image digests before rollout. Back up volumes off-host. Postgres 17, ClickHouse 26.9 and Redis 7 are the Compose baseline. Dragonfly can replace Redis with the documented hashtag queue prefix and compatible locking configuration.

## First run

Copy .env.example to .env and restrict permissions (`chmod 600 .env`). Generate unique Postgres, ClickHouse and auth secrets privately. Set NODE_ENV=production and APP_URL to the public HTTPS origin. Set DATABASE_URL host to postgres, CLICKHOUSE_URL to http://clickhouse:8123, REDIS_URL to redis://redis:6379/0, and configure SMTP. URL-encode special characters in connection strings. Keep CLICKHOUSE_DATABASE=trailmark: query-user policies currently target this database explicitly.

```sh
docker compose build
docker compose up -d postgres clickhouse redis
docker compose run --rm server pnpm --filter @trailmark/database migrate:deploy
docker compose run --rm server pnpm --filter @trailmark/clickhouse migrate
# Provisioning writes generated credentials to the mounted env, without rotation.
# The invoking container user must have write access to this file.
docker compose run --rm --user "$(id -u):$(id -g)" -v "$PWD/.env:/workspace/.env" server pnpm --filter @trailmark/clickhouse create-query-user
docker compose up -d --force-recreate server app worker
```

Provisioning requires ClickHouse CREATE USER / SETTINGS PROFILE / ROW POLICY and grant authority. It installs SELECT-only query credentials with constant resource limits and project row policies on all four event tables. It verifies existing grants and preserves existing credentials. Do not insert blank query-user keys in .env before running it. See [query isolation](query-language.md#sql-mode-langsql). Keep all database and API ports private. Optional development mail: `docker compose --profile mail up -d mailpit`; SMTP_HOST=mailpit, SMTP_PORT=1025. Never use Mailpit for public production delivery.

## Operations

The worker registers hourly retention enforcement and handles requested purges. Monitor worker.ready, retention.failed, RetentionRun records and queue lag; a live HTTP server does not prove retention is running. Graceful shutdown waits for the active job. Retention deletes are permanent, including when lowering a project's retention.

Back up Postgres with pg_dump, ClickHouse with native BACKUP to a configured off-host destination, Redis AOF and the private env file. Coordinate snapshots or pause ingestion and the worker for a consistent recovery point. Encrypt backups and rehearse restoration to a separate installation before customer use. Never use `docker compose down -v` on retained data.

For upgrades record the source SHA and image IDs, back up, stop writers/worker, build the new revision, apply Postgres and ClickHouse migrations, restart and run the deployment smoke checks. There are no automatic schema downgrades: rollback binaries only if schemas remain compatible; otherwise restore the matched backup to an isolated installation and verify before switching traffic.
