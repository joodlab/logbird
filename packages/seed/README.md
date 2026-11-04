# Fictional hospitality and accounting data

```sh
# SDK dogfood path; the key determines the destination project
pnpm seed --key <ingest-key> --endpoint http://localhost:4601
# Local ClickHouse (copy the gitignored root .env into a new worktree first)
pnpm seed --sink direct --project-id seed-staydesk-dev --events 300000 --days 60 --reset
pnpm seed --sink direct --project-id seed-ledger-dev --project "Ledger demo" --events 5000 --reset
# Read back overview, vocabulary, samples, operation tree and tenant profile
node --env-file=.env --import tsx packages/seed/src/inspect.ts
```

Options: `sink` (api/direct), `endpoint`, `key`, `project-id`, `project`, `events`,
`days`, `seed` (integer, default 42), `reset`, `benchmark`. The generator accepts
an explicit `now` for reproducibility; CLI runs use current time for relative
console ranges. IDs depend on project/seed, timestamps also depend on `now`.
Use `--reset` for replacement rather than appending a second run.

Reset calls the existing `purgeProject` with exactly the supplied project ID,
awaits deletion of events and its derived aggregates, then inserts bounded
5,000-row batches. It never drops a database or creates Postgres records. Stop
concurrent writers to that demo project during replacement. In API mode, reset
also requires local ClickHouse credentials and `--project-id`; the caller must
ensure the ingest key belongs to that same project. No public reset API exists.
API errors/rejections fail the command; direct mode bypasses HTTP by design.

## Dataset

StayDesk has 30 invented hospitality businesses, 1-3 websites each, 150 fictional
staff across owner/admin/editor/marketer/revenue roles, three support identities,
API-key automation, and masked guest labels. Email and URL fixtures use reserved
`example.com` names; no customer records, phone numbers, credentials or production
connections are used. Secret changes contain `[redacted]` on both sides.

The default 300k fixture covers 94 action names, including policies, rates,
bookings, guests, campaign lifecycle, translations, exports, access, domains,
media and security. Action-specific changes include SAR prices, roles, dates,
flags, titles and statuses. These are illustrative events rather than a replay
of a transactional database: repeated edits can independently revisit a record.

Twelve businesses have both guest and booking feeds enabled. Each completed hour
has separate :05 and :35 scheduler requests, including nights and weekends.
The remaining traffic favors busy staff/businesses, Sunday-Thursday office hours
in Asia/Riyadh, and the later part of the window. Import volume spikes at 55% of
the window; a WhatsApp outage at 80% increases failed receipts and send retries.
These incidents are relative to the requested window, not historical claims.
Small requested counts are prefixes and may contain only scheduled traffic.

Scheduler actors retain their business/resource-scoped IDs; names include the
business so directory and overview labels distinguish them. The scheduler executor
uses the same name and identity. Business-scoped partner API actors also include
the business in their name.

Request/job/record trees preserve the initiating actor. Workers have stable job
IDs and attempts; retries chain through failed attempts (2 or 3 total), records
point to the successful job, and summaries reconcile examined/changed/unchanged/
skipped counts. Provider timeouts stay unknown without fabricated delivery
receipts. API context includes request ID, 32-hex trace, documentation-range IP
and browser user agent. Support impersonation keeps the effective user as actor.
Exactly 2.5% of events rotate through missing actor, legacy executor shape, and
custom provider fields; missing envelope fields here are intentional.

Ledger uses five invented trading businesses and 17 independent accounting
actions, including invoice approval, refunds, balanced journal posting, bank
changes and period locks. Legacy payloads exercise the accept-anything contract.
Invoice approval requests spawn journal-posting workers and per-invoice child events.
It has no hospitality actions or schedulers.

## Read-only domain references

Inspected the StayDesk source tree; no StayDesk service was contacted or modified.
The audit action names are synthetic labels for those operations, not a claim
that StayDesk already emits this audit vocabulary.

| Source in StayDesk | Seed mapping |
| --- | --- |
| `packages/database/prisma/schema.prisma`: Business, BusinessMembership, BusinessHotel/Room, BusinessGuest/Booking, BusinessCrmCampaign, WebsiteArticle/Asset | Tenants, staff, typed records; capacity, isPublished, checkInTime, startDate, status, locale and campaign changes |
| `apps/server/src/actions/website/article.ts` | Publish, schedule, archive, restore revisions and translate articles |
| `apps/server/src/actions/impersonation.ts` | Effective user actor plus separate platform support impersonator |
| `packages/bullmq/src/constants.ts`, `types.ts`, `jobs/business-crm.ts` | business-crm; crm:sync:guests/bookings, crm:campaign:send, staggered hourly schedules |
| `apps/server/src/bull/processors/content.ts` | content; sync:business-hotels and translation:article |
| `apps/server/src/bull/processors/website.ts`, `email.ts`, `business-crm-export.ts` | website:screenshot, invitation email and CRM exports |
| `apps/worker/src/processors.ts` | Separate queue executors rather than substituting workers for actors |
| `apps/server/src/modules/public/webhooks/{meta-whatsapp,staybook}/handlers.ts` | Provider-originated receipt and booking events with webhook executors |

Rate-plan, policy-hour, page and accounting labels are illustrative vocabulary;
page events represent theme content, and payment-provider is a fictional source.
The campaign model uses CANCELLED/FAILED (rather than inventing PAUSED).

## Verification

```sh
pnpm --filter @trailmark/seed typecheck
pnpm exec ultracite check packages/seed
pnpm --filter @trailmark/seed test
```

Tests stream all 300k fixtures and verify exact counts, determinism, time bounds,
parent existence/order, inherited actors, worker attempts, scheduler identity,
vocabulary, outcome coverage, 150 users/30 tenants, reserved addresses, and 2.5%
legacy coverage. They also exercise independent Ledger vocabulary. Generation is
streaming: only a tree and the sink batch are retained; tests retain IDs to check
references. A fixed `now` is necessary for byte-for-byte replay.

`--benchmark` runs local read timings five times; these are local observations,
not a scale SLA. `inspect.ts` reads only the two named demo projects from the
`trailmark` database. Direct seed does not create console project memberships,
a demo login, or validate the HTTP ingest path. Screenshots are not needed to
verify the data package; the PR includes actual read API output as evidence.
