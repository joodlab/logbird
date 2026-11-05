# Backend gaps verification

Local evidence, 2026-11-04; isolated test namespace `trailmark`, branch server port 4602.
No CI, deployment, production, apps/app or packages/ui changes.

## Checks

- `pnpm install --frozen-lockfile`: passed.
- `pnpm typecheck`: passed, 12 tasks, Prisma generation retained.
- `pnpm check`: passed, 199 files.
- `pnpm test`: passed, 7 tasks (57 unit tests; two ClickHouse integration tests skipped without env).
- `node --env-file=.env node_modules/vitest/vitest.mjs run`: 59 passed, six files, including real ClickHouse.
- `SERVER_URL=http://127.0.0.1:4602 pnpm e2e`: passed OTP, org, SDK, gzip/limits, data endpoints, exports, retention counts/rebuild and purge.
- `SERVER_URL=http://127.0.0.1:4602 node --env-file=.env --import tsx scripts/backend-gaps-smoke.ts`: real curl assertions passed; requires demo, creates/deletes an isolated fictional project.

## Curl receipts

Script invokes `curl.exe --fail-with-body --silent --show-error -H "Cookie: <private session>" <endpoint><path>` after OTP login. Credentials are never logged.
Paths: `/retention?preview=1`, `/facets?field=actor|tenant|executor|target`, `/events?q=<all six aliases plus OR/group>`, `/live?since=<arrival>`, `/histogram?from=2020-01-01T00:00:00Z&to=2020-01-01T00:03:00Z&interval=60`, `/retention` after confirmed lowering, and demo `/entities?kind=actor&q=scheduler&limit=100`. All project paths use `/api/projects/:projectId`.

```text
demo scheduler labels [{"id":"crm-hourly-biz_1-bookings","name":"Hourly CRM bookings scheduler - Dar Al Wafa Hotels"},{"id":"crm-hourly-biz_1-guests","name":"Hourly CRM guests scheduler - Dar Al Wafa Hotels"},{"id":"crm-hourly-biz_10-bookings","name":"Hourly CRM bookings scheduler - Layali Orchard Inns"}]
retention preview {"retentionDays":90,"oldestEventAt":"2026-10-21T21:56:06.042Z","nextPurgeAt":"2026-11-04T22:34:25.115Z","previewDeletedEvents":1,"lastRun":null}
facets actor [{"value":"u","label":"Named actor","count":1}]
facets tenant [{"value":"biz","label":"Named tenant","count":1}]
facets executor [{"value":"worker","label":"Named worker","count":1}]
facets target [{"value":"r","label":"Named record","count":1}]
query aliases + boolean {"total":1,"ids":["late-arrival"]}
live late arrival [{"id":"late-arrival","timestamp":"2026-10-21T21:56:06.042Z","receivedAt":"2026-11-04T21:56:06.051Z"}]
empty histogram {"interval":60,"buckets":[{"ts":"2020-01-01T00:00:00.000Z","total":0,"byOutcome":{}},{"ts":"2020-01-01T00:01:00.000Z","total":0,"byOutcome":{}},{"ts":"2020-01-01T00:02:00.000Z","total":0,"byOutcome":{}}]}
completed purge {"retentionDays":7,"oldestEventAt":null,"nextPurgeAt":"2026-11-04T22:34:25.115Z","previewDeletedEvents":null,"lastRun":{"startedAt":"2026-11-04T21:56:07.291Z","finishedAt":"2026-11-04T21:56:19.377Z","deletedEvents":1,"status":"completed","cutoff":"2026-10-28T21:56:07.291Z","error":null}}
malformed boolean status 422
Backend gaps HTTP regression passed
```

## Typecheck timing

Reported 9+ minutes did not reproduce. Forced uncached wall time on this host: **12.73s before**, **7.32s after**. Additional cold run with server/worker/database dist directories absent: **6.11s**, 12 successful tasks, zero cached. Original dependency graph ran 14 tasks. Source-first exports need no builds; current app does not import server RPC declarations. `setup` and `^setup` retain Prisma generation. Production build tasks are unchanged.

## Demo

Existing provisioning command replaced only the requested fictional StayDesk and Ledger demo projects; generator + command provide the replay path. Provisioning reconciled stored counts.

```text
{"project":"StayDesk","events":300000,"seconds":54.1789991,"eventsPerSecond":5537}
{"project":"StayDesk","route":"overview","milliseconds":[98,73,78,75,59]}
{"project":"StayDesk","route":"events?q=action:hotel.*","milliseconds":[116,108,127,109,108]}
{"project":"Ledger demo","events":5000,"seconds":1.0343696999999956,"eventsPerSecond":4834}
{"project":"Ledger demo","route":"overview","milliseconds":[50,40,40,37,29]}
{"project":"Ledger demo","route":"events?q=action:hotel.*","milliseconds":[35,47,47,46,47]}
```

## Cleanup and limits

Reviewed task diff against 05db1f7. Removed redundant label copying and obsolete unsupported-grammar error alternatives. Wrapped entity queries before adding scope so OR cannot escape entity scope. No further actionable slop found. No added dependency or speculative abstraction. Verification proves local behavior; at-least-once aggregate caveats remain documented.

Screenshots/video are not meaningful for backend-only changes; curl receipts and stored-data readback provide equivalent verification. Parallel UI workspace untouched.
