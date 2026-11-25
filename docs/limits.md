# Limits

Every limit Logbird applies to one event and to one request, with what happens past it. The numbers are read from the
code (`EVENT_LIMITS` and `REQUEST_LIMITS` in `packages/contracts/src/events.ts`, the occurredAt bounds in
`packages/clickhouse/src/timestamp.ts`, and the server environment for rate limits);
`packages/clickhouse/src/limits-doc.test.ts` fails when a number in the first two tables drifts from the code.

## Per event

Two limits reject an event: its size, and numbers nested too deep to store exactly. The event is then listed in
`rejected[]` (code `invalid_event`) and the other events of the request are still stored. Past every other limit
below, the event is accepted and its stored `payload` keeps everything that was sent; what is cut is the indexed copy
that search, facets, `record:`, scoped reads and exports read. The event detail (`GET /v1/events/{id}`, `payload`) and
the complete export (`format=jsonl-evidence`) return the original.

| Limit | Value | Past it | Flagged |
| --- | --- | --- | --- |
| Event size | 262144 bytes (256 KiB), the event as JSON once parsed | The event is **rejected** | `rejected[]`, `invalid_event` |
| Number depth | 1000 levels of nesting | An event holding a number deeper than this is **rejected** (it could not be stored exactly) | `rejected[]`, `invalid_event` |
| Targets indexed | 64 | Only the first 64 entries, in the order sent, feed the record index (a numeric id too long to index never does). A record named only after them does not find the event by `record:`, `target:` or a target scope. | Warning `targets_truncated`, attribute `logbird.truncated.targets` |
| Changes indexed | 256 | Only the first 256 entries, in the order sent, are indexed. A field changed only after them is not found by `changes.field:`. | Warning `changes_truncated`, attribute `logbird.truncated.changes` |
| Change field name | 256 UTF-16 code units | The name is indexed cut to at most 256 code units (after trimming surrounding whitespace). | Warning `change_fields_truncated`, attribute `logbird.truncated.changeFields` |
| Attributes indexed | 256 keys | Fields outside the envelope are flattened into attributes; keys past the 256th are not indexed. Logbird's own reserved keys (`logbird.occurredAt.rejected`, `logbird.truncated.*`) are added after them and do not count. | No |
| Attribute value | 2048 UTF-8 bytes | The value is indexed cut to at most 2048 bytes; a number that does not fit is not indexed. | No |
| Attribute depth | 6 levels of nesting | An object nested deeper is indexed as JSON text at the sixth level. A key that itself contains dots adds more segments to the indexed path. | No |
| Description | 4096 UTF-16 code units | Indexed cut to at most 4096. | No |
| occurredAt | 3650 days before to 1 day after receipt | The event is stored at its receipt time. | Warning without a code, attribute `logbird.occurredAt.rejected` (the value, cut to 256 characters, when it can be indexed) |

Ids, names and other envelope strings have their own column caps (for example 256 for ids, 512 for names, 64 for types);
see the event contract (`eventInputSchema`).

### Reading a cut

A cut is reported twice: in the ingest answer, and on the stored event.

- **Ingest answer.** `warnings[]` gets one entry per cut of an event that was stored:
  `{ index, reason, code, sent, indexed, limit }` for targets and changes, `{ index, reason, code, cut, limit }` for
  field names. `reason` says the same in words; neither holds event data. An event listed in `rejected[]` (for example
  a `duplicate_id_conflict`, which keeps the event stored before it) gets no cut warning. Warnings without a `code`
  (an unusable `occurredAt`, a numeric id) are unchanged.
- **Stored event.** Reserved attributes hold the counts as decimal text: `logbird.truncated.targets` (targets sent),
  `logbird.truncated.changes` (changes sent), `logbird.truncated.changeFields` (field names cut). Compare them with
  `targets.length` and `changes.length` of the event. Find cut events with `attr.logbird.truncated.targets:*`,
  `attr.logbird.truncated.changes:*` or `attr.logbird.truncated.changeFields:*` (join them with `OR` for all three).

From this release on, only Logbird writes under `logbird.truncated`: a value a producer sends there is never indexed
(the payload keeps it), so a cut can be neither forged nor hidden on events this release stores. Two kinds of stored
events need care:

- Events stored by an earlier release (or by an earlier server during a rolling upgrade) carry no Logbird-issued
  count even when they were cut, and may hold a producer value under these keys. An exact retry of such an event is
  accepted without storing anything new: its answer warns about the cut, and the stored event keeps no count.
- To be sure a count was issued by Logbird, compare it with the original payload (`targets.length`, `changes.length`).
  The console does this, and shows its cut notes only when the payload confirms them.

Every reader of the event sees these attributes, including tenant-scoped keys, viewer tokens and masked scopes: they
are counts, never values. A masked scope gets `payload: null` and no complete export, so it can see that an event was
cut but cannot read the rest; a full read key reads the original from the detail or the complete export.

To stay under the limits, split a bulk operation into several events that share one `context.operationId`.

## Per request

| Limit | Value | Past it |
| --- | --- | --- |
| Ingest batch | 1000 events | 413 `payload_too_large`, nothing stored |
| Ingest body | 5242880 bytes (5 MiB) after gzip decoding | 413 `payload_too_large`, nothing stored |
| Search page (`limit`) | 200 events (default 50) | 422 `validation_error` |
| Facet values (`limit`) | 100 (default 10) | 422 `validation_error` |
| Facet second level (`byLimit`) | 20 (default 5) | 422 `validation_error` |
| Query size (`q`) | 4096 UTF-8 bytes | 422 `invalid_query` |
| Query terms (`q`) | 64 terms | 422 `invalid_query` |
| Query nesting (`q`) | 16 levels of parentheses | 422 `invalid_query` |
| Search count (`total`) | 10001 | `total` stops there and `totalExact` is false |
| Detail parent walk | 100 parents | `parents` holds at most the 100 nearest ancestors (furthest first). The walk also stops at a parent that is not stored or not visible to the reader. |
| Viewer-token request body | 16384 bytes (16 KiB) | 413 `payload_too_large` |
| Time window of search, facets and export without `from` | 24 hours before `to` | Older events are not read: pass `from` for a longer history. Event detail by id has no window. |

### Rate limits

Per minute, fixed windows, with `RateLimit-*` headers on authenticated answers and 429 `rate_limited` with
`Retry-After` past them. Self-hosters set them with these environment variables (defaults shown).

| Bucket | Default | Variable |
| --- | --- | --- |
| Ingest, per project | 3000 requests | `INGEST_RATE_LIMIT_PER_MINUTE` |
| Reads, per project | 1200 requests | `READ_RATE_LIMIT_PER_MINUTE` |
| Viewer-token reads, per minting key and tenant | 300 requests | `VIEWER_READ_RATE_LIMIT_PER_MINUTE` |
| Viewer-token minting, per key | 600 requests | `VIEWER_TOKEN_MINT_RATE_LIMIT_PER_MINUTE` |
| Failed authentication, per client address | 600 requests | `PUBLIC_RATE_LIMIT_PER_MINUTE` |

Public limits fail open when Redis is unavailable: the request goes through without `RateLimit-*` headers.
