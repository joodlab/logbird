# Event exports

The console exports every match of the authorized project's query and time range, in ascending event order.
`GET /api/projects/:projectId/export` uses `exportQuerySchema` in `@logbird/contracts`:
`from`, `to`, `q`, `lang=query|sql`, and required `format=csv|jsonl|jsonl-evidence`.
The default range is resolved once, before paging, and recorded as UTC timestamps.

- **CSV (normalized, spreadsheet-safe)** represents all normalized event fields. Its stable columns are
  `id,project_id,timestamp,received_at,environment,action,category,outcome,severity,description,actor_type,actor_id,actor_name,actor_email,impersonator_id,impersonator_name,executor_type,executor_id,executor_name,job_id,job_attempt,tenant_id,tenant_name,source,targets,changes,context,attributes,conformance,schema_version,sdk`.
  `targets`, `changes`, `context`, and `attributes` are JSON cells; changes retain normalized before/after strings.
  Empty optional scalar fields are empty cells. Cells beginning with `=`, `+`, `-`, `@`, tab, CR or LF receive
  an apostrophe before RFC4180 quoting, following [OWASP CSV Injection guidance](https://owasp.org/www-community/attacks/CSV_Injection).
  Spreadsheet software can strip escaping on re-save; this encoding applies to the original export. This deliberately changes those
  cell values, including negative numbers represented as text. Use evidence JSONL for original values.
- **JSON Lines (normalized)** preserves the existing `AuditEvent` object per line. Search normalization caps strings
  and flattened attributes (including the 2048-character attribute cap); this format does not preserve the original document.
- **JSON Lines (original evidence)** writes `{ "exportSchemaVersion": 1, "event": <AuditEvent>, "payload": <stored JSON> }`
  per line. `event` provides the server ID, project ID, receipt timestamp and normalized search representation.
  `payload` embeds the stored JSON document verbatim, without normalization caps or a parse/stringify round trip.
  It preserves long values, nested objects, arrays and unknown keys. Storage holds the JSON serialization accepted at
  ingestion (maximum 256 KiB per event), not the original HTTP body's whitespace, gzip bytes or batch envelope.
  Evidence files use an `-evidence.jsonl` suffix. Missing payloads fail the export rather than silently emitting incomplete evidence.

## Workspace receipts and failure policy

Every authorized export stores `export.requested` before reading/sending event bytes, followed by
`export.completed` or `export.failed`. The request ID correlates these records. Each retains actor, affected project,
format, trimmed query text and language, canonical range, request IP/user agent, row count and UTF-8 byte count.
No event content is copied into receipts. CSV counts exclude the header from rows, but include it in bytes.
Failed records distinguish `client_aborted` from `export_error`; exceptions and credentials are not recorded.

Counts measure chunks enqueued to the response, not acknowledgement that a client saved the file. Completion means
the producer exhausted all pages and stored its completion receipt before closing the stream. Client cancellation
or request abort records partial counts and closes the iterator (an in-flight database query may finish first).
If the initial receipt cannot be stored, the export fails closed. If a terminal receipt cannot be stored, the response
errors and the requested receipt remains pending; operators must investigate pending receipts and storage health.
There is no automatic receipt retry or guaranteed terminal receipt during process termination/storage outage.
Consumers must discard partial/errored downloads. Paging is not a snapshot; concurrent retention or deletion can
change results. No migration or self-hoster configuration change is required.
