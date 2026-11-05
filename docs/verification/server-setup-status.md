# Local setup-status verification

Captured 2026-11-05T03:45:53.919Z against server 4621 and local dependencies. Demo and test records are fictional. Fixture workspace removed after capture.

### JoodCMS uncached

`curl -sS --cookie <private-cookie-file> -w "\n%{http_code} %{time_total}" http://127.0.0.1:4621/api/projects/cmw2jcawb0000ewyoqcnu1wkn/setup`

```text
{"projectId":"cmw2jcawb0000ewyoqcnu1wkn","generatedAt":"2026-11-05T03:45:53.008Z","progress":{"done":5,"total":8},"complete":false,"nextStep":"retention","dismissedAt":null,"steps":[{"id":"ingest_key","status":"done","required":true,"completedAt":"2026-11-04T19:54:30.660Z"},{"id":"first_event","status":"done","required":true,"completedAt":"2026-11-04T21:52:57.976Z"},{"id":"recent_events","status":"done","required":true,"completedAt":null},{"id":"envelope","status":"done","required":true,"completedAt":null},{"id":"operation_id","status":"done","required":false,"completedAt":null},{"id":"retention","status":"todo","required":true,"completedAt":null},{"id":"read_key","status":"todo","required":false,"completedAt":null},{"id":"teammate","status":"todo","required":false,"completedAt":null}],"ingest":{"activeIngestKeys":7,"firstEventAt":"2026-11-04T21:52:57.976Z","firstEvent":{"id":"JoodCMS-s42-op0-0","projectId":"cmw2jcawb0000ewyoqcnu1wkn","timestamp":"2026-09-05T22:05:00.000Z","receivedAt":"2026-11-04T21:52:57.976Z","environment":"production","action":"crm.sync.requested","category":"crm","outcome":"success","severity":"info","description":"Hourly CRM guests scheduler - Dar Al Wafa Hotels requested guests processing for Dar Al Wafa Hotels.","actor":{"type":"system","id":"crm-hourly-biz_1-guests","name":"Hourly CRM guests scheduler - Dar Al Wafa Hotels","email":""},"impersonator":null,"executor":{"type":"scheduler","id":"crm-hourly-biz_1-guests","name":"Hourly CRM guests scheduler - Dar Al Wafa Hotels","jobId":"","attempt":0},"tenant":{"id":"biz_1","name":"Dar Al Wafa Hotels"},"source":"joodcms","targets":[{"type":"website","id":"web_1_1","name":"dar-al-wafa-hotels.example.com"}],"changes":[],"context":{"operationId":"JoodCMS-s42-op0","parentEventId":"","requestId":"","traceId":"","ip":"","userAgent":""},"attributes":{"metadata.fictional":"true","metadata.role":"owner","metadata.locale":"ar","metadata.queue":"business-crm","metadata.jobName":"crm:sync:guests","metadata.schedulerId":"crm-hourly-biz_1-guests","metadata.cron":"5 * * * *"},"conformance":100,"schemaVersion":"1","sdk":"typescript/0.0.0"},"lastEventAt":"2026-11-04T21:53:51.924Z","eventsLast24h":300000,"sampleEvents":0},"envelope":{"sampledEvents":10000,"avgConformance":99.7261,"target":70,"fields":[{"field":"actor","coverage":0.9917,"missingQuery":"-actor:*"},{"field":"executor","coverage":0.9917,"missingQuery":"-executor:*"},{"field":"tenant","coverage":1,"missingQuery":"-tenant:*"},{"field":"targets","coverage":1,"missingQuery":"-target:*"},{"field":"outcome","coverage":1,"missingQuery":null},{"field":"occurredAt","coverage":1,"missingQuery":null}]},"operations":{"coverage":1,"eventsWithOperationId":10000},"retention":{"retentionDays":90,"reviewedAt":null},"readKeys":{"active":0},"team":{"members":1,"pendingInvitations":0}}
200 0.169977
```

### JoodCMS cached

`curl -sS --cookie <private-cookie-file> -w "\n%{http_code} %{time_total}" http://127.0.0.1:4621/api/projects/cmw2jcawb0000ewyoqcnu1wkn/setup`

```text
{"projectId":"cmw2jcawb0000ewyoqcnu1wkn","generatedAt":"2026-11-05T03:45:53.133Z","progress":{"done":5,"total":8},"complete":false,"nextStep":"retention","dismissedAt":null,"steps":[{"id":"ingest_key","status":"done","required":true,"completedAt":"2026-11-04T19:54:30.660Z"},{"id":"first_event","status":"done","required":true,"completedAt":"2026-11-04T21:52:57.976Z"},{"id":"recent_events","status":"done","required":true,"completedAt":null},{"id":"envelope","status":"done","required":true,"completedAt":null},{"id":"operation_id","status":"done","required":false,"completedAt":null},{"id":"retention","status":"todo","required":true,"completedAt":null},{"id":"read_key","status":"todo","required":false,"completedAt":null},{"id":"teammate","status":"todo","required":false,"completedAt":null}],"ingest":{"activeIngestKeys":7,"firstEventAt":"2026-11-04T21:52:57.976Z","firstEvent":{"id":"JoodCMS-s42-op0-0","projectId":"cmw2jcawb0000ewyoqcnu1wkn","timestamp":"2026-09-05T22:05:00.000Z","receivedAt":"2026-11-04T21:52:57.976Z","environment":"production","action":"crm.sync.requested","category":"crm","outcome":"success","severity":"info","description":"Hourly CRM guests scheduler - Dar Al Wafa Hotels requested guests processing for Dar Al Wafa Hotels.","actor":{"type":"system","id":"crm-hourly-biz_1-guests","name":"Hourly CRM guests scheduler - Dar Al Wafa Hotels","email":""},"impersonator":null,"executor":{"type":"scheduler","id":"crm-hourly-biz_1-guests","name":"Hourly CRM guests scheduler - Dar Al Wafa Hotels","jobId":"","attempt":0},"tenant":{"id":"biz_1","name":"Dar Al Wafa Hotels"},"source":"joodcms","targets":[{"type":"website","id":"web_1_1","name":"dar-al-wafa-hotels.example.com"}],"changes":[],"context":{"operationId":"JoodCMS-s42-op0","parentEventId":"","requestId":"","traceId":"","ip":"","userAgent":""},"attributes":{"metadata.fictional":"true","metadata.role":"owner","metadata.locale":"ar","metadata.queue":"business-crm","metadata.jobName":"crm:sync:guests","metadata.schedulerId":"crm-hourly-biz_1-guests","metadata.cron":"5 * * * *"},"conformance":100,"schemaVersion":"1","sdk":"typescript/0.0.0"},"lastEventAt":"2026-11-04T21:53:51.924Z","eventsLast24h":300000,"sampleEvents":0},"envelope":{"sampledEvents":10000,"avgConformance":99.7261,"target":70,"fields":[{"field":"actor","coverage":0.9917,"missingQuery":"-actor:*"},{"field":"executor","coverage":0.9917,"missingQuery":"-executor:*"},{"field":"tenant","coverage":1,"missingQuery":"-tenant:*"},{"field":"targets","coverage":1,"missingQuery":"-target:*"},{"field":"outcome","coverage":1,"missingQuery":null},{"field":"occurredAt","coverage":1,"missingQuery":null}]},"operations":{"coverage":1,"eventsWithOperationId":10000},"retention":{"retentionDays":90,"reviewedAt":null},"readKeys":{"active":0},"team":{"members":1,"pendingInvitations":0}}
200 0.016194
```

### Fresh project before ingestion

`curl -sS --cookie <private-cookie-file> -w "\n%{http_code} %{time_total}" http://127.0.0.1:4621/api/projects/cmw306n5k0000jkyoia29q371/setup`

```text
{"projectId":"cmw306n5k0000jkyoia29q371","generatedAt":"2026-11-05T03:45:53.677Z","progress":{"done":1,"total":8},"complete":false,"nextStep":"first_event","dismissedAt":null,"steps":[{"id":"ingest_key","status":"done","required":true,"completedAt":"2026-11-05T03:45:53.339Z"},{"id":"first_event","status":"todo","required":true,"completedAt":null},{"id":"recent_events","status":"todo","required":true,"completedAt":null},{"id":"envelope","status":"todo","required":true,"completedAt":null},{"id":"operation_id","status":"todo","required":false,"completedAt":null},{"id":"retention","status":"todo","required":true,"completedAt":null},{"id":"read_key","status":"todo","required":false,"completedAt":null},{"id":"teammate","status":"todo","required":false,"completedAt":null}],"ingest":{"activeIngestKeys":1,"firstEventAt":null,"firstEvent":null,"lastEventAt":null,"eventsLast24h":0,"sampleEvents":0},"envelope":{"sampledEvents":0,"avgConformance":0,"target":70,"fields":[{"field":"actor","coverage":0,"missingQuery":"-actor:*"},{"field":"tenant","coverage":0,"missingQuery":"-tenant:*"},{"field":"executor","coverage":0,"missingQuery":"-executor:*"},{"field":"targets","coverage":0,"missingQuery":"-target:*"},{"field":"outcome","coverage":0,"missingQuery":null},{"field":"occurredAt","coverage":0,"missingQuery":null}]},"operations":{"coverage":0,"eventsWithOperationId":0},"retention":{"retentionDays":90,"reviewedAt":null},"readKeys":{"active":0},"team":{"members":1,"pendingInvitations":0}}
200 0.027228
```

### First ingestion

HTTP 202: `{"accepted":1,"ids":["01a1a9d0-2820-7e2c-b424-095bdf11b950"],"rejected":[]}`

### Fresh project after ingestion

`curl -sS --cookie <private-cookie-file> -w "\n%{http_code} %{time_total}" http://127.0.0.1:4621/api/projects/cmw306n5k0000jkyoia29q371/setup`

```text
{"projectId":"cmw306n5k0000jkyoia29q371","generatedAt":"2026-11-05T03:45:53.913Z","progress":{"done":3,"total":8},"complete":false,"nextStep":"envelope","dismissedAt":null,"steps":[{"id":"ingest_key","status":"done","required":true,"completedAt":"2026-11-05T03:45:53.339Z"},{"id":"first_event","status":"done","required":true,"completedAt":"2026-11-05T03:45:53.696Z"},{"id":"recent_events","status":"done","required":true,"completedAt":null},{"id":"envelope","status":"attention","required":true,"completedAt":null},{"id":"operation_id","status":"todo","required":false,"completedAt":null},{"id":"retention","status":"todo","required":true,"completedAt":null},{"id":"read_key","status":"todo","required":false,"completedAt":null},{"id":"teammate","status":"todo","required":false,"completedAt":null}],"ingest":{"activeIngestKeys":1,"firstEventAt":"2026-11-05T03:45:53.696Z","firstEvent":{"id":"01a1a9d0-2820-7e2c-b424-095bdf11b950","projectId":"cmw306n5k0000jkyoia29q371","timestamp":"2026-11-05T03:45:53.696Z","receivedAt":"2026-11-05T03:45:53.696Z","environment":"production","action":"x","category":"x","outcome":"success","severity":"info","description":"","actor":null,"impersonator":null,"executor":null,"tenant":null,"source":null,"targets":[],"changes":[],"context":{"operationId":"","parentEventId":"","requestId":"","traceId":"","ip":"","userAgent":""},"attributes":{},"conformance":0,"schemaVersion":"","sdk":"node"},"lastEventAt":"2026-11-05T03:45:53.696Z","eventsLast24h":1,"sampleEvents":0},"envelope":{"sampledEvents":1,"avgConformance":0,"target":70,"fields":[{"field":"actor","coverage":0,"missingQuery":"-actor:*"},{"field":"tenant","coverage":0,"missingQuery":"-tenant:*"},{"field":"executor","coverage":0,"missingQuery":"-executor:*"},{"field":"targets","coverage":0,"missingQuery":"-target:*"},{"field":"outcome","coverage":0,"missingQuery":null},{"field":"occurredAt","coverage":0,"missingQuery":null}]},"operations":{"coverage":0,"eventsWithOperationId":0},"retention":{"retentionDays":90,"reviewedAt":null},"readKeys":{"active":0},"team":{"members":1,"pendingInvitations":0}}
200 0.026660
```
## Implementation notes

The three ClickHouse queries run concurrently: lifetime arrival/count facts, the earliest real event
(serialized by the existing `toEvent` helper), and aggregate coverage over the latest 10000 real
arrivals in seven days. Lifetime facts must scan all retained client timestamps because a newly
received event can be backdated. Project predicates precede raw payload reads. On an empty project,
the uncached HTTP path measured 27 ms.

The 500-project in-process LRU stores only ClickHouse facts for 30 seconds and never stores a
project without a real first event. Key create/revoke, project PATCH, sample mutations and ingestion
invalidate local entries. Other replicas converge within 30 seconds; Postgres facts are always read
fresh. No Dragonfly cache schema or new dependency was needed.

Sample data uses a small independent fictional reservation/billing vocabulary instead of importing
the CLI-oriented seed package. It shares the ingest normalizer and durable ClickHouse insert helper.
The accepted raw envelope fields are `outcome` and `occurredAt`; the current normalizer does not
accept `timestamp` as an alias. Tests verify that defaulted outcome/time do not inflate coverage.

Deletion uses a project-and-source-scoped lightweight DELETE, then the existing rollup SQL rebuilds
`entities`, `attribute_keys` and `events_by_minute` from all surviving rows under the ingestion lock.
This preserves real-event contributions even when their aggregate groups overlap samples. The
operation is retryable but is not a transaction across ClickHouse commands: after a storage/process
failure, retry sample removal/replacement to rebuild aggregates. Automatic crash recovery and
failure injection are not included.

Backend-only changes have no meaningful screenshot or motion artifact; the HTTP transcripts and
real-service assertions provide equivalent evidence.
## Validation receipts

```text
pnpm install
Done in 16.1s using pnpm v10.30.3

pnpm --filter @trailmark/database migrate:dev --name project_setup_status
Applying migration `20261105034007_project_setup_status`
Your database is now in sync with your schema.

pnpm typecheck
Tasks: 12 successful, 12 total

pnpm check
Checked 213 files. No fixes applied.

pnpm test
Tasks: 8 successful, 8 total (6 cached)
server: Test Files 4 passed; Tests 8 passed
```

The root ClickHouse test command does not load `.env` and skips its existing service tests;
these were additionally executed against the shared ClickHouse service:

```text
node --env-file=.env node_modules/vitest/vitest.mjs run packages/clickhouse/src/integration.test.ts
Test Files 1 passed (1)
Tests 5 passed (5)
Duration 62.43s
```

The server integration test always uses real Postgres, ClickHouse and Mailpit (no mocks), including
OTP login, no-workspace/project onboarding, key create/revoke, sample replacement/removal, minimal
and complete envelopes, timestamp non-alias coverage, retention confirmation/review, dismissal,
invitation freshness, anonymous rejection, neighboring-project sample preservation, backdated
arrival semantics, OpenAPI registration and surviving real-event entity/field rollups.

Final cleanup review: inspected the task-owned diff against `97fca22`, including the new files.
Removed an unnecessary dynamic import and unused timestamp mutation; reused the existing serializer,
normalizer, project lock and rollup rebuild SQL. No remaining actionable slop found. The final code
passed the checks above. No contract edits, UI changes, deployment or merge were made. The temporary
server on port 4621 was stopped and proof fixture projects/workspace were removed.
