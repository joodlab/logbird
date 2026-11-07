# Event exports

`GET /api/projects/:projectId/export` accepts `from`, `to`, `q`, `lang=query|sql`, and required
`format=csv|jsonl|jsonl-evidence`. The console and HTTP clients use the same contracts and authorization.
Every matching event is exported in ascending event order. The query is compiled once with one export clock;
its resolved range, compiled predicate/parameters and clock appear in the terminal record. Relative query bounds
and SQL `now`, `now64`, `today`, `yesterday` calls stay fixed across pages. SQL clock functions need literal
precision/time zones; use explicit timestamps for more complex expressions. Paging is not a database snapshot:
concurrent ingestion, retention and deletion can still change the rows visible between pages.

## Which format?

- **Complete (original payloads)** — `jsonl-evidence`. Each line contains `exportSchemaVersion: 1`, the normalized
  `event`, and the stored original JSON in `payload`. The latter preserves accepted nested/unknown/long values;
  it does not preserve HTTP whitespace, compression or the batch wrapper. Normalized fields and payload are selected
  from the same physical row, including legacy versions with tied timestamps. Missing stored payloads fail the export.
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

Completion, failure and cancellation are inserted into the [durable audit outbox](workspace-audit.md), independently
retried by the API drainer. A terminal audit outage cannot break an otherwise successful export. A Postgres outage at the
terminal insert is reported as `export.audit_storage_unavailable` and can leave a requested record requiring operator
investigation; completed bytes cannot be reconstructed after process loss. Server shutdown drains tracked terminal
writes before closing clients. Cancellation during an in-flight completion emits a later corrective `export.failed`
record for the same export id; treat that cancellation as the final state. Reasons are `client_aborted`, `invalid_query`,
`storage_unavailable`, `export_error`; private exception messages and event contents are excluded.

Completion means the producer exhausted its pages and handed bytes to the stream. Counts are not client receipt
acknowledgement. Discard partial or errored downloads. An in-flight database query may finish before iterator cleanup.
The console buffers a Blob, so very large downloads depend on browser memory; HTTP clients can stream to disk.
There is no whole-export row/byte budget. Deploy the server and console together after the outbox migrations.

Until #62 lands, this branch uses the existing duplicate-id arbitration. Complete exports pair the selected normalized row with its exact stored payload; immutable first-acceptance and ambiguous-retry guarantees belong to #62 and require combined verification.
