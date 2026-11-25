# Limits

Every limit Logbird applies to one event and to one request, with what happens past it. The numbers are read from the
code (`EVENT_LIMITS` and `REQUEST_LIMITS` in `packages/contracts/src/events.ts`, and the server environment for rate
limits); `packages/clickhouse/src/limits-doc.test.ts` fails when a number in the first two tables drifts from them.

## Per event

An event over one of these limits is still accepted, and its stored `payload` keeps everything that was sent. What is
cut is the indexed copy that search, facets, `record:`, scoped reads and exports read. The event detail
(`GET /v1/events/{id}`, `payload`) and the complete export (`format=jsonl-evidence`) return the original.

| Limit | Value | Past it | Flagged |
| --- | --- | --- | --- |
| Targets indexed | 64 | The first 64 are indexed, in the order sent. A search by record (`record:`, `target:`) or a target scope does not find the event for the others. | Yes: warning `targets_truncated`, attribute `logbird.truncated.targets` |
| Changes indexed | 256 | The first 256 are indexed, in the order sent. `changes.field:` does not find the others. | Yes: warning `changes_truncated`, attribute `logbird.truncated.changes` |
| Change field name | 256 UTF-16 code units | The name is indexed cut to at most 256 (after trimming surrounding whitespace). | Yes: warning `change_fields_truncated`, attribute `logbird.truncated.changeFields` |
| Attributes indexed | 256 keys | Fields outside the envelope are flattened into attributes; keys past the 256th are not indexed. | No |
| Attribute value | 2048 UTF-8 bytes | The value is indexed cut to at most 2048 bytes; a number that does not fit is not indexed. | No |
| Attribute depth | 6 path segments | An object nested deeper is indexed as JSON text at the sixth segment. | No |
| Description | 4096 UTF-16 code units | Indexed cut to at most 4096. | No |
| Event size | 262144 bytes (256 KiB), the event as JSON once parsed | The event is **rejected** (`rejected[]`, code `invalid_event`); the other events of the request are still stored. | Rejected |

Ids, names and other envelope strings have their own column caps (for example 256 for ids, 512 for names, 64 for types);
see the event contract (`eventInputSchema`).

### Reading a cut

A cut is reported twice: in the ingest answer, and on the stored event.

- **Ingest answer.** `warnings[]` gets one entry per cut: `{ index, reason, code, sent, indexed, limit }` for targets
  and changes, `{ index, reason, code, cut, limit }` for field names. `reason` says the same in words. Neither holds
  event data. Warnings without a `code` (an unusable `occurredAt`, a numeric id) are unchanged.
- **Stored event.** Reserved attributes hold the counts as decimal text: `logbird.truncated.targets` (targets sent),
  `logbird.truncated.changes` (changes sent), `logbird.truncated.changeFields` (field names cut). Compare them with
  `targets.length` and `changes.length` of the event. Find every cut event with
  `attr.logbird.truncated.targets:*` (or `.changes`, `.changeFields`).

Only Logbird writes under `logbird.truncated`: a value a producer sends there is dropped from the attributes (the
payload keeps it), so a cut can be neither forged nor hidden. Events stored before this release carry no such
attribute even when they were cut.

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
| Query (`q`) | 4096 UTF-8 bytes | 422 `invalid_query` |
| Search count (`total`) | 10001 | `total` stops there and `totalExact` is false |
| Detail parent walk | 100 parents | `parents` holds the 100 nearest ancestors (furthest first); older ones are not returned |
| Time window without `from` | 24 hours before `to` | Older events are not read: pass `from` for a longer history |

### Rate limits

Per minute, fixed windows, with `RateLimit-*` headers on every authenticated answer and 429 `rate_limited` with
`Retry-After` past them. Self-hosters set them with these environment variables (defaults shown).

| Bucket | Default | Variable |
| --- | --- | --- |
| Ingest, per project | 3000 requests | `INGEST_RATE_LIMIT_PER_MINUTE` |
| Reads, per project | 1200 requests | `READ_RATE_LIMIT_PER_MINUTE` |
| Viewer-token reads, per minting key and tenant | 300 requests | `VIEWER_READ_RATE_LIMIT_PER_MINUTE` |
| Viewer-token minting, per key | 600 requests | `VIEWER_TOKEN_MINT_RATE_LIMIT_PER_MINUTE` |
| Failed authentication, per client address | 600 requests | `PUBLIC_RATE_LIMIT_PER_MINUTE` |

Public limits fail open when Redis is unavailable.
