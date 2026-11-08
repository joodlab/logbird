# Event exports

`GET /api/projects/:projectId/export` accepts `from`, `to`, `q`, `lang=query|sql`, and required
`format=csv|jsonl|jsonl-evidence`. The console and HTTP clients use the same contracts and authorization.
Every matching event is exported in ascending event order. The query is compiled once with one export clock;
its resolved range, compiled predicate/parameters and clock appear in the terminal record. Relative query bounds
and SQL `now`, `now64`, `today`, `yesterday` calls stay fixed across pages. SQL clock functions need literal
precision/time zones; use explicit timestamps for more complex expressions.

Membership is the matching rows committed at the short admission boundary with `received_at <=` the frozen export start, ordered by occurrence time/id.
Later received backdated rows are excluded on both sides of the cursor. The receive-time fence is applied to both
the candidate lookup and the selected physical row. It uses stored receive timestamps, not a cross-replica wall-clock
or transaction-commit ordering guarantee. Legacy duplicate arbitration remains the existing search policy.

Retention/sample replacement advance a Postgres project generation **before** destructive I/O. Deletion persists
a start marker before purging. Export admission drains earlier ingests with the existing short exclusive project lock
and commits its receive fence before allowing new writers in. Writers whose receive timestamps fall inside an active
fence mark that export invalid **before** inserting into ClickHouse, covering delayed normalization and replica clock
skew. Ordinary later-received writes stay excluded. Final validation takes the same short exclusive lock, drains prior
writes and compares the lease invalidation flag and generation/retention-run boundary. A changed boundary, in-progress/failed retention or deletion
fails the stream with `membership_changed`, rather than recording completion of an incomplete file. Discard the
partial file and retry. No lock or Postgres transaction spans the download. Direct administrative ClickHouse writes
that bypass these application fences require stopping exports first. This is not a general database snapshot.

The ingest fence piggybacks on the existing project lookup in one SQL statement: **zero additional Postgres round
trips per batch**, whether an export is active or not. An indexed lease probe returns no rows when inactive; ordinary
later-received writes do not update the active lease. Only the first delayed write marks a lease invalid.
Both export boundary acquisitions use nonblocking advisory tries with a 100-ms contention budget. Their short
Postgres transaction has `lock_timeout=100ms`, `statement_timeout=100ms`, a 250-ms transaction deadline and 50-ms
pool-admission deadline. These are transaction-local settings. Contention returns `503 export_project_busy`
(`project_busy` terminal reason) and releases the writer-preference gate, allowing new ingests to continue behind
the earlier shared writer. No ClickHouse I/O runs under an exclusive export boundary lock.

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

Every authorized export stores a durable `export.requested` record and obtains its ingest acknowledgement **before
reading or sending event bytes**. Rejected entries and `503 ingest_pending` are not acknowledgement; the HTTP
response uses export-specific `503 export_audit_unavailable` copy. The pending frozen record stays in the outbox
for reconciliation. A failed acknowledgement independently attempts a correlated zero-byte failure record when
Postgres is available. Invalid range, invalid query and unavailable restricted SQL-client preparation occur inside this
lifecycle and produce correlated failure records when initial audit storage is available.

Requested evidence and an unconfirmed `export.outcome_unknown` fallback are inserted in **one Postgres transaction**
with the admission lease. Without that commit no event bytes leave. Completion/failure/cancel UPDATE the provisional
terminal payload, retrying the exact event four times with backoff. Settlement atomically freezes that payload and
releases admission. Cancellation while completion is in flight supersedes its provisional draft, so only the final
outcome is delivered. Drafts are never ingested. If storing cancellation fails, an earlier completion draft cannot
be confirmed by mistake. Recovery after an already-frozen unknown may add a separately identified correction.

A terminal storage outage cannot break successful bytes: the pre-existing unknown fallback remains durable. On a
producer crash or failed settlement, every API replica's sweeper confirms expired fallbacks using short row locks
and `SKIP LOCKED`. Drafts are discarded after a crash: they are not proof of stream settlement. Unknown records have
null rows/bytes and no digest; they never imply success. Safe diagnostics are `export.audit_storage_unavailable
{exportId,action}` and `export.release_failed {exportId}`. The outbox independently retries delivery. Server shutdown
drains tracked terminal writes before closing clients; a forced exit leaves the durable leased fallback.

Reasons are `client_aborted` (download canceled), `invalid_query`, `audit_unavailable` (audit record not confirmed),
`sql_unavailable` (SQL mode unavailable), `membership_changed`, `project_busy`, `idle_timeout`, `lease_expired`, `resource_limit`,
`export_error`, and `outcome_not_confirmed`. Sentences name the cause; private exception messages are excluded.

Completion means the producer exhausted its pages and handed bytes to the stream. Counts are not client receipt
acknowledgement. Discard partial or errored downloads. An in-flight database query may finish before iterator cleanup.
The console buffers a Blob, so very large downloads depend on browser memory; HTTP clients can stream to disk.
There is no row-total truncation. Admission is shared by replicas through expiring Postgres leases: one export per
user, two per workspace, and two weighted slots per audit namespace (ordinary export: one; SQL: both). A 30-second idle deadline, 15-minute duration deadline and
60-second lease (renewed every 10 seconds) bound slow/disconnected producers. Abort/settlement releases capacity;
expired capacity is reclaimed after a crash. Admission denial is `429 export_busy`, before any file or audit request
is started. Ordinary pages have a 10-second query deadline, 128 MiB memory, 256 MiB read-byte budget, two threads and
throw-on-overflow. Restricted SQL retains its existing immutable profile: 10 seconds, 1 GiB memory/read bytes,
four threads and throw-on-overflow. It reserves both admission slots so admitted export query memory is at most
1 GiB for SQL, or 256 MiB for two ordinary queries, below the shared 1.79 GiB ClickHouse cap. Other query traffic
still shares that server cap. Exports skip the unused per-page count scan. Deploy the server/worker/console together
after the additive Postgres migrations; no ClickHouse migration is needed.

Outbox retention keeps delivered evidence for seven days and never removes awaiting/undelivered/quarantined rows.
Expired admission leases are bounded sweep deletions; they contain ids only, no event payloads. To investigate an
unknown outcome, search its export id and check independent request logs. Never infer a digest or saved file from
the provisional draft. Use the [outbox requeue procedure](workspace-audit.md) only for frozen delivery failures.

Until #62 lands, this branch uses the existing duplicate-id arbitration. Complete exports pair the selected normalized row with its exact stored payload; immutable first-acceptance and ambiguous-retry guarantees belong to #62 and require combined verification.
