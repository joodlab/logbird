# Trailmark

Open-source (MIT), self-hostable audit log & activity history. Send any event from your product through the SDK
or HTTP API, keep it for as long as your project's retention says, and follow every user, tenant, worker and record
in a fast console built on ClickHouse.

- Spec: [`docs/SPEC.md`](docs/SPEC.md)
- Agent/contributor guide: [`AGENTS.md`](AGENTS.md)

```bash
pnpm install
pnpm db:deploy && pnpm ch:migrate
pnpm dev            # app http://localhost:4600 · server http://localhost:4601
pnpm seed           # StayDesk-shaped demo data; sign in as demo@trailmark.local (OTP in Mailpit :8025)
```

## End-to-end local development

Use Node 22.18+ and pnpm 10. Copy the gitignored root .env into your worktree.
The shared Trailmark Postgres, ClickHouse, Dragonfly and Mailpit services must
already be available. Do not start duplicate backing containers.

    pnpm install
    pnpm db:generate
    pnpm db:deploy
    pnpm ch:migrate
    pnpm dev

Root dev starts the server (4601), retention worker, and app (4600) when its
workspace exists. Each process loads the root .env. API reference:
http://localhost:4601/docs (public API key and internal session routes).

In another terminal, pnpm e2e exercises OTP login through Mailpit, project
creation, SDK ingest, search, exports and retention/purge against real services.
It uses isolated fictional fixtures. Run pnpm demo --sink api to provision
Raed (demo), the Acme workspace, and 300,000 StayDesk + 5,000 Ledger demo events.
It purges previous demo project rows before streaming the exported seed generator
through the public API with the SDK. For a quick run, use --events 1000
--ledger-events 100. Each run creates fresh keys and preserves existing keys.
Sign in as demo@trailmark.local; find its OTP at http://127.0.0.1:8025.

Ingest supports gzip, at most 1,000 events / 5 MiB decoded per request and
256 KiB per event. A 202 waits for ClickHouse async insert acknowledgement.
Invalid events appear in rejected; size failures return 413. Storage budget
failures return 503 and malformed queries 422. Delivery and aggregate counts
are at least once, as documented in packages/clickhouse/README.md.

Retention lowering requires the slug and synchronously purges and rebuilds
derived tables. Ingestion and worker purges share a Postgres advisory lock
across processes. Failed rebuilds block ingestion until a successful retry.
