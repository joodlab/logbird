# Synthetic seed

```sh
# Default API dogfood path (requires server ingest route and a project ingest key)
pnpm seed --key <ingest-key> --endpoint http://localhost:4601
pnpm seed --sink direct --project-id seed-staydesk-dev --events 300000 --days 60 --benchmark
pnpm seed --sink direct --project-id seed-ledger-dev --project "Ledger demo" --events 5000
```

Options: sink, endpoint, key, project-id, project, events, days, seed, benchmark.
The generator accepts an explicit `now` for reproducible fixtures. CLI runs use
current time so data is visible in relative ranges. IDs are deterministic for
project/seed; do not replay the same run into an existing project: changing `now`
changes timestamps. CLI is append-only and never silently purges existing data.

Domain vocabulary comes from read-only inspection of StayDesk's Prisma models,
action directories, queue constants, CRM/business-CRM job definitions and worker
dispatch. Examples include Business/Website, BusinessGuest/Booking,
WebsiteCrmCampaign, BusinessHotelRoom, WebsiteArticle and WebsiteAsset;
business-crm/content/email/website/notifications queues, crm:sync:bookings,
crm:campaign:send, translated content and screenshots. No StayDesk connection or
customer data is used. Other models/actions are intentionally representative
synthetic vocabulary. Business/website tenants, 150 users and roles, scheduler
actors, API-key actors, support impersonation, provider webhooks, request/job/
record trees, retry attempts, changes, seasonality and off-standard fields are
generated with a seeded PRNG. Ledger uses invoice/journal/account/payment terms.

Direct mode owns only its supplied project_id. It does not create Postgres
projects or a demo login; the server/database implementation owns that setup and
must map the dev project IDs to project records. API mode uses the SDK and an
existing ingest key. Benchmark mode runs each query five times over the full
seed range and prints milliseconds; these are local observations, not a scale SLA.
