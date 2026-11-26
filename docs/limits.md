# Limits

The limits that decide what Logbird stores and what a read returns, with what happens past each. Request validation
has more bounds than these: the request schemas in `packages/contracts` are the full list. The numbers are read from the
code (`EVENT_LIMITS` and `REQUEST_LIMITS` in `packages/contracts/src/events.ts`, the occurredAt bounds in
`packages/clickhouse/src/timestamp.ts`, and the server environment for rate limits);
`packages/clickhouse/src/limits-doc.test.ts` fails when the number in the Value column of a row it checks drifts from the
code (and, for page sizes, query terms, nesting and the default window, when the stated behaviour does). It does not
check the wording of the other columns, nor the event id, viewer-token lifetime, facet path and export rows.

## Per event

Three limits reject an event: its id, its size, and numbers nested too deep to store exactly. The event is then listed
in `rejected[]` and the other events of the request are still stored. Past every other limit
below, the event is accepted and its stored `payload` keeps everything that was sent; what is cut is the indexed copy
that search, facets, `record:`, scoped reads and exports read. The event detail (`GET /v1/events/{id}`, `payload`) and
the complete export (`format=jsonl-evidence`) return the original.

| Limit | Value | Past it | Flagged |
| --- | --- | --- | --- |
| Event id | 256 UTF-16 code units (after trimming) | An id that is longer, holds NUL or an unpaired surrogate is **rejected** | `rejected[]`, `invalid_event_id` |
| Event size | 262144 bytes (256 KiB), the event as JSON once parsed | The event is **rejected** | `rejected[]`, `invalid_event` |
| Number depth | 1000 levels of nesting | An event that nests deeper than this and also holds, anywhere, a number a double cannot keep exactly is **rejected** | `rejected[]`, `invalid_event` |
| Targets indexed | 64 | Only the first 64 entries, in the order sent, feed the target index (a numeric id too long to index never does). Later entries add nothing to the index: `record:`, `target:` and a target scope find the event only through an indexed target (which can still match a later one by the same, or a shortened, value). | Warning `targets_truncated`, attribute `logbird.truncated.targets` |
| Changes indexed | 256 | Only the first 256 entries, in the order sent, are indexed; later entries add nothing to the index, so `changes.field:` finds the event only through an indexed field. | Warning `changes_truncated`, attribute `logbird.truncated.changes` |
| Change field name | 256 UTF-16 code units | Among the indexed changes, a longer name is indexed cut to at most 256 code units (after trimming surrounding whitespace). A long name only past the 256th change is covered by `changes_truncated`. | Warning `change_fields_truncated`, attribute `logbird.truncated.changeFields` |
| Attributes indexed | 256 keys | Fields outside the envelope are flattened into attributes; keys past the 256th are not indexed. A producer value under a reserved key (`logbird.occurredAt.rejected`, `logbird.truncated.*`) takes a slot like any key and is then dropped or replaced; Logbird's own values are added after the 256 and do not count. | No |
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

From 0.4.1 on, only Logbird writes under `logbird.truncated`: a value a producer sends there is never indexed
(the payload keeps it), so a cut can be neither forged nor hidden on events stored by 0.4.1 or later. Two kinds of stored
events need care:

- Events stored before 0.4.1 (or by an older server during a rolling upgrade) carry no Logbird-issued
  count even when they were cut, and may hold a producer value under these keys. An exact retry of such an event (the
  same string `id`, with a stored identity that still matches) is accepted without storing anything new: its answer warns
  about the cut, and the stored event keeps no count. A retry whose stored identity no longer matches is a
  `duplicate_id_conflict`, with no cut warning.
- The original payload tells whether a count is true (`targets.length`, `changes.length`), not who wrote it. The
  console compares the two and shows its cut notes only when they agree. A masked reader has no payload to compare
  with, and `attr.logbird.truncated.targets:*` can also find such an older producer value.
- An event resent without a string `id` gets a new id and is stored again.

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
| Viewer-token lifetime (`ttlSeconds`) | 60 to 3600 seconds (default 900) | 422 `validation_error` |
| Facet attribute path (`attr.<path>`) | 4096 characters after the prefix | 422 `validation_error` |
| Exports running at once | 1 per API key or console user, 2 per workspace, and a server-wide cap | 429 `export_busy` until one ends |
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
