# Event exports

`GET /api/projects/:projectId/export` accepts `from`, `to`, `q`, `lang=query|sql`, and required
`format=csv|jsonl|jsonl-evidence`. The console and HTTP clients use the same contracts and authorization.
Every matching event is exported in ascending event order. The query is compiled once with one export clock;
its resolved range, compiled predicate/parameters and clock appear in the terminal record. Relative query bounds
and SQL `now`, `now64`, `today`, `yesterday` calls stay fixed across pages. SQL clock functions need literal
precision/time zones; use explicit timestamps for more complex expressions.

An export includes matching events accepted before it started; for example, yesterday's event received after the export started is excluded.
Membership is the matching rows committed at the short admission boundary with `received_at <=` the frozen export start, ordered by occurrence time/id.
Later received backdated rows are excluded on both sides of the cursor. The receive-time fence is applied to both
the candidate lookup and the selected physical row. It uses stored receive timestamps, not a cross-replica wall-clock
or transaction-commit ordering guarantee. Immutable ingestion acknowledges exact retries by their stored fingerprint without reinserting a later physical version; receipt recovery retains its original receive time and participates in the same fence.

Retention, sample removal/replacement and project deletion advance a Postgres project generation and persist a durable pending fence in `Project.exportDeleteStartedAt` **before raw DELETE**. Retention stages this marker in the same transaction as its run and generation. A crash or ambiguous failure leaves the fence intact; a newer completed derived-table repair cannot supersede it. Holding the project lock alone never clears it: shared reconciliation checks that no project-tagged queries remain in `system.processes` and no unfinished mutations for the project's five tables remain in `system.mutations`. Unknown/unscoped mutation commands conservatively keep the fence. Only then does a compare-and-set clear the marker, under the exclusive project lock, outside a Postgres transaction. Existing run checks remain an additional guard.

An independent API loop ticks every ten seconds and drains on shutdown. It uses one-row lookahead to rotate at most five projects per sweep without an empty reset sweep. With five or fewer pending projects and healthy dependencies, each project is retried on every tick; larger sets rotate through pages. Lock contention or a slow/unavailable ClickHouse can delay settlement, and errors retain the fence. Every sweep warns for unresolved fences older than five minutes: `maintenance.reconciliation_pending {projectId,ageSeconds,code:destructive_work_pending}`. Failed reconciliation logs the safe code `reconciliation_unavailable`. Age never expires a fence.

To diagnose a warning, inspect that project's `logbird-maint:<base64url(projectId)>:` query-id prefix in `system.processes`, then `system.mutations` (`is_done=0`) on `events`, `event_ids`, `events_by_minute`, `entities` and `attribute_keys`, including `latest_fail_reason`. Include unknown/unscoped mutation commands when checking for blockers. Repair the underlying mutation error or settle the identified operation; let verified reconciliation clear the marker. Do not unset the marker manually or treat an ingest repair as evidence that a raw purge finished. The export refusal reads "Data maintenance is incomplete for this project. Retry after maintenance finishes", covering retention, sample replacement and deletion.

Export admission drains earlier ingests with the existing short exclusive project lock
and commits its receive fence before allowing new writers in. Admission and final validation also wait for unresolved in-flight receipts whose original receive time is inside that fence and whose claim is within the 60-second lease plus 10-second async-flush bound: an ambiguous INSERT can remain queued after its ingest caller releases the shared lock. Older abandoned claims and fresh post-fence claims do not block forever. Confirmation or recovery unblocks the export; if settlement exceeds the bounded wait, the export returns `export_project_busy` with `Retry-After: 1`, without reserving a download. Fresh writes receive their acceptance clock inside the shared project lock, strictly after active fences. Only replays whose original receive timestamps fall inside an active fence mark it invalid **before** inserting into ClickHouse. Ordinary later-received writes stay excluded. Final validation takes the same short exclusive lock, drains prior
writes and compares the lease invalidation flag and generation/retention-run boundary. A changed boundary, in-progress/failed retention or deletion
fails the stream with `membership_changed`, rather than recording completion of an incomplete file. An unreadable project at admission still records requested/failed evidence with `project_unreadable` and an honest maintenance message; no query capacity is reserved. A validation storage outage is `storage_unavailable`, not a claim that stored events changed. Discard the
partial file and retry. No lock or Postgres transaction spans the download. Direct administrative ClickHouse writes
that bypass these application fences require stopping exports first. This is not a general database snapshot.

The acceptance clock and replay fence piggyback on the existing project lookup and receipt claim/takeover statements: **zero additional Postgres round
trips per batch**, whether an export is active or not. An indexed lease probe returns no rows when inactive; ordinary
later-received writes do not update the active lease. Only the first late replay marks a lease invalid.
Both export boundary acquisitions use nonblocking advisory tries with a 100-ms contention budget. Their short
Postgres transaction has `lock_timeout=100ms`, `statement_timeout=100ms`, a 250-ms transaction deadline and 50-ms
pool-admission deadline. These are transaction-local settings. Contention returns `503 export_project_busy`
and releases the writer-preference gate, allowing new ingests to continue behind
the earlier shared writer. No ClickHouse I/O runs under an exclusive export boundary lock.
Admission and final validation retry only contention, with 25–75 ms jitter and a 30-second retry budget (plus the last bounded attempt); every attempt retains the 100-ms lock-wait bound and releases its gate before waiting. Sustained contention can still fail a fully streamed file with `project_busy`; discard it and retry. Sustained admission contention returns without a download. These bounded probes improve progress when writes take seconds; they do not guarantee progress under arbitrarily long or continuously overlapping writers. The console initially shows `Preparing export…`. After one second without headers it says `waiting for server` and explains that active writes may delay preparation by up to 30 seconds; it does not claim every response delay is caused by writes. Once headers arrive it switches to `Downloading export <id>…`, including during final-boundary validation. Cancel interrupts backoff and shows its confirmation under a new toast id. After the last page, the consumer-idle timer is cleared while final validation waits; request cancellation, lease renewal and the 15-minute duration limit remain active.

## Which format?

- **Complete (original payloads)** — `jsonl-evidence`. Each line contains `exportSchemaVersion: 1`, the normalized
  `event`, and the stored original JSON in `payload`. The latter preserves accepted nested/unknown/long values;
  it does not preserve HTTP whitespace, compression or the batch wrapper. Normalized fields and payload are selected
  from the same physical row, including legacy versions with tied timestamps. Missing or malformed stored JSON fails
  the export. Literal CR/LF in externally inserted payload text also fails, protecting JSONL framing. Syntax validation
  does not reserialize valid JSON or change large-number text.
- **Spreadsheet (CSV)** — every normalized field; long values follow normalizer caps. UTF-8, comma delimiters,
  quoted cells, escaped double quotes, LF records, no BOM. The original five-column prefix is preserved:
  `id,timestamp,action,outcome,description`. Appended columns are
  `project_id,received_at,environment,category,severity,actor_type,actor_id,actor_name,actor_email,impersonator_id,impersonator_name,executor_type,executor_id,executor_name,job_id,job_attempt,tenant_id,tenant_name,source,targets,changes,context,attributes,conformance,schema_version,sdk,schemaVersion`.
- **JSON Lines (all fields)** — `jsonl`. Each line is a normalized event plus `exportSchemaVersion: 1`.
  It contains every normalized field, including attributed actors and before/after changes, with normalizer caps.

`X-Logbird-Export-Schema` is `<format>/1`. CSV `schemaVersion` and JSONL `exportSchemaVersion` version the export
layout; CSV `schema_version` and normalized event `schemaVersion` describe the producer's original event schema.
The receipt also carries the export schema version.

### Data dictionary

`id` is the stable event id; `project_id` identifies its stream. `timestamp` is occurrence time and `received_at`
is the stored receive time of the selected event version, both ISO UTC strings. `job_attempt` is an integer; `conformance` is a score
from 0 to 100. `targets`, `changes`, `context`, `attributes` are JSON cells. Other CSV fields are strings, with empty
values for missing optional data. JSONL keeps structured objects/arrays and the contract's numeric types.

### Spreadsheet handling

CSV quotes preserve delimiters/newlines. Separately, an apostrophe is prefixed to text beginning with `= + - @`
or full-width `＝ ＋ － ＠`, including after leading whitespace/control/format characters. Leading tab/CR/LF is
also protected. Original text after that apostrophe is retained. CSV has no numeric cell types: every value is quoted. Formula-leading values, including numeric `-1`, receive an apostrophe. Positive numerals are unchanged and spreadsheet imports may infer their types; this encoding is intentionally not number-preserving. A negative number, or an id beginning with `-`/`@`, may
therefore differ from its JSONL spelling. Use complete JSONL for exact reconciliation. Import CSV with text columns;
spreadsheet applications and locale-specific import modes are not certified by the byte-level regression tests.

## File-to-record verification

The response includes `X-Logbird-Export-Id`, also present in the HTTP attachment filename and the console download
filename (`logbird-events-<full-export-id>[-evidence].csv|jsonl`). Workspace records share that id as
`context.operationId`, `metadata.export.exportId` and an export target. Their sentences show the same short id so
requested and terminal rows are clearly linked while preserving immutable state transitions.

A completed record carries `sha256`, `bytes`, `rows` and format version. SHA-256 and bytes cover exactly the UTF-8
chunks handed to the response stream, including the CSV header; the row count excludes that header. Compare the
record to `Get-FileHash -Algorithm SHA256 <file>` and `(Get-Item <file>).Length` on Windows, or `sha256sum <file>`
and `wc -c <file>` elsewhere. Matching those values establishes that the file matches the producer's output;
it does not establish who saved it or when it reached a client's disk.

## Audit lifecycle and failures

Admission refusals (`429 export_busy`, `503 export_project_busy`) are not exports and leave no activity record.
Every admitted authorized export stores a durable `export.requested` record and obtains its ingest acknowledgement **before
reading or sending event bytes**. Rejected entries and `503 ingest_pending` are not acknowledgement; the HTTP
response uses export-specific `503 export_audit_unavailable` copy. The pending frozen record stays in the outbox
for reconciliation. A failed acknowledgement independently attempts a correlated zero-byte failure record when
Postgres is available. Invalid range, invalid query and unavailable restricted SQL-client preparation occur inside this
lifecycle and produce correlated failure records when initial audit storage is available.

Requested evidence and an unconfirmed `export.outcome_unknown` fallback are inserted in **one Postgres transaction**
with the admission lease. Without that commit no event bytes leave. Completion/failure/cancel UPDATE the provisional
terminal payload, retrying the exact event four times with backoff. Terminal settlement freezes that payload promptly;
admission is released separately after the producer's pending read and iterator cleanup settle. Cancellation while completion is in flight supersedes its provisional draft, so only the final
outcome is delivered. Drafts are never ingested. If storing cancellation fails, an earlier completion draft cannot
be confirmed by mistake. Recovery after an already-frozen unknown may add a separately identified correction.

A terminal storage outage cannot break successful bytes: the pre-existing unknown fallback remains durable. On a
producer crash or failed settlement, every API replica's sweeper confirms expired fallbacks using short row locks
and `SKIP LOCKED`. Drafts are discarded after a crash: they are not proof of stream settlement. Unknown records have
null rows/bytes and no digest; they never imply success. Safe diagnostics are `export.audit_storage_unavailable
{exportId,action}` and `export.release_failed {exportId}`. The outbox independently retries delivery. Server shutdown
drains tracked terminal writes before closing clients; a forced exit leaves the durable leased fallback.

Reasons are `client_aborted` (download canceled), `invalid_query`, `audit_unavailable` (audit record not confirmed),
`sql_unavailable` (SQL mode unavailable), `membership_changed`, `project_unreadable`, `storage_unavailable`, `project_busy`, `idle_timeout`, `lease_expired`, `resource_limit`,
`export_error`, and `outcome_not_confirmed`. Sentences name the cause; private exception messages are excluded.

Completion means the producer exhausted its pages and handed bytes to the stream. Counts are not client receipt
acknowledgement. Discard partial or errored downloads. Each page has a generated query id. Cancellation requests `KILL QUERY … SYNC` through the API's existing server client and keeps weighted capacity charged until both the original read and cancellation acknowledgement settle, followed by iterator cleanup. An early no-match or failed cancellation cannot release an ongoing read's capacity.
`KILL QUERY` and reconciliation inspect one ClickHouse node. Multi-node deployments behind a load balancer are unsupported by this settlement proof; query cancellation still retains capacity until the original read settles or reaches its deadline.
The console buffers a Blob, so very large downloads depend on browser memory; HTTP clients can stream to disk.
There is no row-total truncation. Admission is shared by replicas through expiring Postgres leases: one export per
user, two per workspace, and two weighted slots per audit namespace (ordinary export: one; SQL: both). A 30-second idle deadline, 15-minute duration deadline and
60-second lease (normally renewed every 10 seconds) bound slow/disconnected producers. Transient renewal failures retry every second while the existing lease has slack; a separate monotonic deadline aborts at a 10-second safety margin, even if renewal hangs. Abort freezes failure promptly, then producer cleanup releases capacity;
expired capacity is reclaimed after a crash. Admission denial is `429 export_busy`, before any file or audit request
is started. Ordinary pages have a 10-second query deadline, 128 MiB memory, 256 MiB read-byte budget, two threads and
throw-on-overflow. Restricted SQL retains its existing immutable profile: 10 seconds, 1 GiB memory/read bytes,
four threads and throw-on-overflow. It reserves both admission slots so admitted export query memory is at most
1 GiB for SQL, or 256 MiB for two ordinary queries, below the shared 1.79 GiB ClickHouse cap. Other query traffic
still shares that server cap. Exports skip the unused per-page count scan. Deploy the server/worker/console together
after the additive Postgres migrations; no ClickHouse migration is needed.

For the first upgrade from workers without the destructive fence, stop the old API/workers and verify their tagged
maintenance queries and unfinished mutations have settled before enabling the new exports. Old failed purges may
not have a marker. Keep exports unavailable while resolving that old work; then start the matching server/worker/console
versions together. All subsequent raw retention, sample and project-deletion submissions use the durable fence.

Outbox retention keeps delivered evidence for seven days and never removes awaiting/undelivered/quarantined rows.
Expired admission leases are bounded sweep deletions; they contain ids only, no event payloads. To investigate an
unknown outcome, search its export id and check independent request logs. Never infer a digest or saved file from
the provisional draft. Use the [outbox requeue procedure](workspace-audit.md) only for frozen delivery failures.

After a broken response stream, the console looks up `GET /api/workspace/exports/:exportId` for the durable failure reason and id. This read rechecks current workspace membership, is scoped to that workspace and namespace, and exposes no provisional drafts. If lookup is unavailable, the toast retains the short id and directs the user to Workspace activity. A producer-completed outcome is distinguished from an interrupted download.

Exact retries acknowledge the original fingerprint without reinserting or replacing its physical row. Fresh acceptance is stamped inside the shared project lock, using Postgres time strictly greater than every active export fence (at least one millisecond). A batch normalized before admission therefore cannot be mistaken for pre-fence membership. Omitted/invalid occurrence times resolve against that first acceptance/receipt clock; retries and recovered receipts retain their original receive time, event time and fingerprint. A previously missing pre-fence replay invalidates an active export before its INSERT. The fence rides the existing project lookup and receipt claim/takeover statements: zero additional PG round trips, with or without an active export. `scripts/benchmark-export-ingest-hook.ts` measures the PG-only statement cost; the integration sample retains batch, receive, fence and CTE telemetry.
