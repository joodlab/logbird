# HyperDX / ClickStack ClickHouse research

Date: 2026-11-04. Research and recommendations only; this PR changes no schema or application code.

## Decision

Require ClickHouse **26.2+** for the initial Trailmark release. Replace the proposed `tokenbf_v1` index with a `text` index on a named, normalized search column. Index arbitrary attribute **pairs**, retain the project-first sorting key, and ship a small typed AST compiler whose semantics are independent of whichever index is available. Keep autocomplete on bounded server-side metadata queries; do not put event documents into a browser search engine.

Before implementing dashboards, resolve ingest idempotency and retention for derived tables. Neither replacing merges nor insert-triggered materialized views gives exactly-once audit counts.

## Evidence scope and navigation

HyperDX was shallow-cloned to `C:/Users/raedb/Desktop/Work/OSS/hyperdx`, commit **253a690d49776c390d2c5b7e4824edeb011f027d**. All `H:` references below are paths and inclusive line ranges inside that clone at that revision. For example, `H:docker/otel-collector/schema/seed/00002_otel_logs.sql:4-44` resolves under that absolute directory. These are source findings, not measured HyperDX production behavior.

Permanent upstream source root: <https://github.com/hyperdxio/hyperdx/tree/253a690d49776c390d2c5b7e4824edeb011f027d>. Trailmark baseline read: `AGENTS.md` and `docs/SPEC.md`, master commit `4204dd6`. No real events were read. The only local data writes were synthetic rows in `trailmark.research_text` and `trailmark.research_pairs`; both tables were dropped.

## 1. Storage: what HyperDX actually creates

### Logs

`H:docker/otel-collector/schema/seed/00002_otel_logs.sql:4-44` defines:

```sql
-- Abbreviated: these are HyperDX's expressions, not Trailmark's proposal.
Timestamp DateTime64(9) CODEC(Delta, ZSTD(3)),
ServiceName LowCardinality(String) CODEC(ZSTD(3)),
Body String CODEC(ZSTD(3)),
ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(3)),
ScopeAttributes Map(LowCardinality(String), String) CODEC(ZSTD(3)),
LogAttributes Map(LowCardinality(String), String) CODEC(ZSTD(3)),
LogAttributeItems Array(String) ALIAS
  arrayMap(arr -> concat(arr.1, '=', arr.2),
           LogAttributes::Array(Tuple(String, String))),
INDEX idx_trace_id TraceId TYPE text(tokenizer = 'array'),
INDEX idx_log_attr_key mapKeys(LogAttributes) TYPE text(tokenizer = 'array'),
INDEX idx_log_attr_items LogAttributeItems TYPE text(tokenizer = 'array'),
INDEX idx_lower_body lower(Body) TYPE text(tokenizer = 'splitByNonAlpha')
-- Resource/Scope attributes get equivalent key/item indexes.
ENGINE = MergeTree
PARTITION BY toDate(Timestamp)
ORDER BY (toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp)
TTL toDateTime(Timestamp) + ${LOGS_TTL}
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1,
         enable_block_number_column = 1, enable_block_offset_column = 1;
```

It also materializes eight commonly filtered Kubernetes/environment attributes into LowCardinality columns (lines 20-27). IDs remain Strings. This keeps frequently used dimensions cheap without abandoning arbitrary maps.

### Traces

`H:docker/otel-collector/schema/seed/00005_otel_traces.sql:4-43` uses ordinary `MergeTree`, daily partitions, `ORDER BY (ServiceName, SpanName, toDateTime(Timestamp))`, and `TTL toDate(Timestamp) + ${TRACES_TTL}` with `ttl_only_drop_parts=1`. Timestamp has Delta/ZSTD(3); other columns mostly ZSTD(3). Resource/span attributes are Maps; span events and links use arrays, including arrays of Maps. Trace ID and materialized RUM session ID have exact-token `text(tokenizer='array')` indexes; map keys and paired items have the same index type; Duration has `minmax GRANULARITY 1`; SpanName has a `splitByNonAlpha` text index with `preprocessor=lower(SpanName)`. SampleRate is a materialized UInt64 with T64/ZSTD.

### Compatibility and rationale

For servers below 26.2 the migration runner selects compatibility DDL (`H:packages/otel-collector/cmd/migrate/main.go:641-665,800-815`). The log compatibility schema uses bloom filters for TraceId and map keys/values (granularity 1), plus `lower(Body) TYPE tokenbf_v1(32768,3,0) GRANULARITY 8`; sorting, daily partitions and codecs remain similar (`H:docker/otel-collector/schema/seed/00002_otel_logs_compat.sql:29-42`). Trace compatibility DDL is in `H:docker/otel-collector/schema/seed/00005_otel_traces_compat.sql:1-45`. The current log/trace seed schemas do not define `ngrambf_v1` indexes. Replay sessions still use tokenbf (`H:docker/otel-collector/schema/seed/00004_hyperdx_sessions.sql:27`). Do not describe all HyperDX tables as having migrated identically.

Interpretation: time partitions prune periods and make whole-part TTL removal cheap; time/service clustering limits common observability scans; compression reduces I/O; LowCardinality helps repeating dimensions; inverted indexes locate rare tokens/IDs/pairs without reading every map value. `ttl_only_drop_parts=1` trades exact expiration timing for cheaper deletion of fully expired parts. These are inferred design consequences, not a throughput benchmark. Trailmark is multi-project: copying HyperDX's service-first trace key would lose the most important tenant isolation/pruning prefix.

## 2. Query language and SQL compilation

### Parser and semantics

`H:packages/common-utils/src/queryParser.ts:1,31-115` imports **`@hyperdx/lucene`**, wraps its parser with special-token encoding, and supplies escaping for LIKE metacharacters. The dependency is declared in `H:packages/common-utils/package.json:17`. The grammar implementation is a dependency, not a parser generator source checked into this clone. AST walking/serialization is in `queryParser.ts:2049-2238`; query-to-SQL entry points are at `2250-2310`.

Important semantic difference from Trailmark: quoted explicit fields take the exact-equality path (`queryParser.ts:2074-2078`); ordinary string field terms can take substring `ILIKE '%term%'` (`1490-1527,1682-1684`). Numeric/boolean fields use typed equality. Trailmark promises **exact** `field:value`, even unquoted; preserve that promise rather than copying HyperDX's default substring behavior.

Field resolution checks physical/materialized columns first, then resolves a Map prefix and keeps the remaining dotted suffix as the key (`queryParser.ts:1700-1787`). For example, `LogAttributes.http.method` resolves to `LogAttributes['http.method']`, not nested map access. Metadata can redirect hot attributes to materialized columns. Map existence `indexHint(mapContains(...))` is added in relevant positive cases; it is an optimizer hint, not a replacement for the real predicate.

Exact map matches can compile to `has(LogAttributeItems, concat(key,'=',value))` when metadata detects the paired text index (`queryParser.ts:555-575,2030-2044`). Empty-string equality needs special handling because a missing map key returns `''`: HyperDX explicitly includes missing keys for that equality, and changes the negated form accordingly. Trailmark should specify presence semantics explicitly.

### Full text and avoiding scans

The implicit/body-field compiler (`queryParser.ts:1536-1684`) detects index metadata and `enable_full_text_index`. With a compatible `splitByNonAlpha` text index it emits `hasAllTokens(...)`, matching `lower(column)` where the index uses it. Token groups are capped/batched at 64. A multi-token or punctuation-containing literal adds a residual `lower(column) LIKE '%literal%'` condition to enforce literal ordering/adjacency. Token intersection alone is not phrase search.

Without that text path it checks a bloom filter over `tokens(...)`, emits `hasAll(tokens(...), tokens(term))`, or falls back to `hasToken(lower(column), lower(token))`; multi-token cases retain a LIKE residual. Wildcards use lower/LIKE. Other string field searches can use ILIKE. These functions do not magically guarantee index use: expression/tokenizer alignment, selectivity, negation and wildcard shape matter. Broad/negative queries still need time/project bounds and budgets. A cast or a differently normalized expression can prevent index matching.

HyperDX uses SQL escaping/serialization (`SqlString.format`) and also parameterized chart SQL. Trailmark should use ClickHouse named typed parameters end to end, plus allowlisted column identifiers, rather than transplanting arbitrary raw SQL support or metadata-dependent field semantics.

### Orama and autocomplete

No Orama dependency/import was found by repository-wide search (`rg -i orama`). There **is** client-side suggestion filtering: `H:packages/app/src/components/SearchInput/AutocompleteInput.tsx:3,57,98-132` uses **Fuse.js**, threshold **0**, `ignoreLocation: true`, and ten displayed suggestions. This filters already fetched options; it is not fuzzy retrieval over event bodies.

`H:packages/app/src/hooks/useAutoCompleteOptions.tsx:197-233,273-324` debounces input 300 ms, defaults metadata to the last 24 hours, loads keys first, fetches values for the active field, and formats key/value completions. `H:packages/common-utils/src/core/metadata.ts:1089-1297,2790-2957` prefers available text-index metadata, then compatible rollups, then raw-table fallback. The shipped rollups cover selected native columns, **not every arbitrary map key**.

The raw fallback `getKeyValues` defaults to 20 values, caches by connection/table/date/filter/keys/limit, and uses bounded `groupUniqArray` over a limited subquery; its bounded path sets 15 seconds and `timeout_overflow_mode='break'` (`metadata.ts:2970-3128`). Suggestions are a bounded sample, not exhaustive top-ranked values.

## 3. Pagination, charts, facets and budgets

* **Event pagination:** the explorer hook generates time windows and uses an OFFSET within each window (`H:packages/app/src/hooks/useOffsetPaginatedQuery.tsx:110-178,220-266`). The shared renderer emits parameterized LIMIT/OFFSET (`H:packages/common-utils/src/core/renderChartConfig.ts:1720-1729`). The external v2 search API documents maxResults 100 by default/2000 maximum, offset maximum 10,000, and warns that timestamp ties make offset results nondeterministic (`H:packages/api/src/routers/external-api/v2/search.ts:121-137`). Do not claim HyperDX universally uses stable keyset pagination. Keep Trailmark's `(timestamp,event_id)` cursor.
* **Histograms:** automatic or explicit intervals become `toStartOfInterval(toDateTime(timestamp), INTERVAL ...)` (`renderChartConfig.ts:870-889`). Additional fill-range construction is at `1015-1041`. Aggregate rendering supports sample weights for already sampled spans (`575-640`); that is distinct from ClickHouse physical `SAMPLE` pruning.
* **Facet distributions/top values:** `getValuesDistribution` defaults to 100,000 target samples and 100 groups, obtains a count/sample factor, applies a `cityHash64(timestamp,rand()) % sample_factor` predicate, groups values and orders percentages descending (`H:packages/common-utils/src/core/metadata.ts:2511-2587`). The code explicitly says the sampling condition still reads rows; it saves value-column work, not all scanning. Group cardinality is bounded with `max_rows_to_group_by=limit*10`, overflow `any`; this may yield incomplete distributions. It is not an exact audit count.
* **Budgets:** the shared client supplies configured `max_execution_time`, cancellation on client close, lazy materialization and top-K/skip-index settings when supported (`H:packages/common-utils/src/clickhouse/index.ts:596-668`). Metadata paths use row limits, caching and deadlines; some deliberately remove max_rows_to_read when another bound is used. A result LIMIT alone is not a scan limit.
* **PREWHERE:** the generic builder should not be described as always explicitly emitting PREWHERE; ClickHouse can move predicates there automatically. The shared client disables subcolumn-size calculation to avoid expensive per-part Map planning on SharedMergeTree (`clickhouse/index.ts:661-667`). Trailmark should explicitly PREWHERE its own project/time envelope, keep complex search in WHERE, and inspect the plan rather than assuming all predicates prune.

## 4. Ingestion, retry and deduplication

`H:docker/otel-collector/config.standalone.yaml:4-15,28-90` wires OTLP gRPC/HTTP receivers to the ClickHouse exporter (with separate rrweb routing). Dynamic configuration is in `H:packages/api/src/opamp/controllers/opampController.ts:257-313`. Exporter schema creation defaults off, JSON attribute mode defaults off, timeout defaults to 5 seconds, and retries use 5-second initial/30-second maximum intervals over 300 seconds. SQL migrations own the tables.

`H:docker/otel-collector/config.yaml:132-152,184-192` sets the batch processor to **10,000 records or 5 seconds**, with max batch size default **0** (no hard cap), plus memory limiting. The comments explicitly aim to avoid many tiny MergeTree parts. Transform processing flattens structured log attributes (`config.yaml:10-17`).

The exporter implementation is **external**, selected by `H:packages/otel-collector/builder-config.yaml:124-127`; the clone's tracked `.env:54` selects OTel **0.155.0**. The pinned upstream [exporter config](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.155.0/exporter/clickhouseexporter/config.go) defaults async insertion on (lines 62-65), subject to endpoint/connection/server overrides. [Log export](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.155.0/exporter/clickhouseexporter/exporter_logs.go#L96-L175) prepares a batch, appends normalized OTLP records, then sends it. HyperDX's local config does not explicitly set `wait_for_async_insert`; do not infer its durability contract solely from those settings. Those upstream files are not vendored into the clone.

Log/trace tables are ordinary MergeTree: no event-ID uniqueness or ReplacingMergeTree deduplication. The binary includes optional `logdedup` (`H:packages/otel-collector/builder-config.yaml:82-84`) but default pipeline processor lists do not activate it. Retried delivery is not an exactly-once event guarantee. Trailmark should keep explicit `async_insert=1, wait_for_async_insert=1`, bound batch bytes as well as rows, and treat response loss/retries as an idempotency problem distinct from insert buffering.

## 5. Materialized views and rollups

`H:docker/otel-collector/schema/seed/00006_otel_logs_rollups.sql:4-25,120-122` and `00007_otel_traces_rollups.sql:4-25,65-66` create 15-minute key/value counts in **SummingMergeTree**, partitioned daily and ordered `(ColumnIdentifier,Key,Timestamp,Value)`. They have timestamp/count minmax indexes and source-specific TTL. Insert-triggered MVs union selected native columns, bucket timestamps, group and count. Query with `sum(count)`/GROUP BY; background merging is not a prerequisite for correct aggregation. Map-key/value discovery can instead read text-index metadata. This seed does not create a universal preaggregated log histogram for every possible search filter.

The shared MV planner rejects views that cannot represent required dimensions/granularity (`H:packages/common-utils/src/core/materializedViews.ts:470-501,797-820,908-930`). Adopt that rule: a rollup cannot answer arbitrary full-text/attribute-filtered counts if those predicates were discarded during aggregation.

## 6. ClickHouse 26.x status and local verification

Official [text-index documentation](https://clickhouse.com/docs/reference/engines/table-engines/mergetree-family/textindexes) says **GA from 26.2**, without an experimental opt-in. Syntax is `INDEX name expression TYPE text(tokenizer = splitByNonAlpha)`; use `tokenizer = array` for whole items. The official [MergeTree reference](https://clickhouse.com/docs/reference/engines/table-engines/mergetree-family/mergetree) recommends text indexes over token/ngram Bloom filters from 26.2. Bloom filters remain probabilistic granule pruning; text indexes map tokens to matching rows. Syntax acceptance of tokenbf does not make it the recommended new design. Avoid assuming every tokenizer in today's docs exists throughout all 26.x releases.

### Observed on the owner's server

HTTP POST to `http://127.0.0.1:8123/?database=trailmark`, authenticated from the primary checkout's `.env` without printing values, returned **26.9.19.9** and database **trailmark**. Observed settings included `enable_full_text_index=1`, `use_skip_indexes=1`, `query_plan_direct_read_from_text_index=1`; the legacy-named `allow_experimental_full_text_index` setting also read 1. That setting name/value is not evidence that this release's feature is experimental. No settings were changed.

Executed two 100,000-row synthetic tests using ordinary MergeTree, granularity 8192, rare marker at id 12345:

| Probe | Observed plan/result |
|---|---|
| `text(splitByNonAlpha)` on a materialized `lowerUTF8(body)`; `hasToken(search_text,'rareneedle')` | `idx_text`, 1/13 granules; exact row id 12345 returned |
| Separate `text(array)` on mapKeys/mapValues; `attributes['metadata.plan']='pro'` | key and value indexes appeared; values reduced 13 granules to 1, with residual map equality |
| Length-prefixed pair alias with `text(array)`; `has(attribute_items,'13:metadata.planpro')` | `idx_pairs`, 1/12 granules; exact row id 12345 returned |
| Arabic literal `hasToken(body,'مرحبا')` with text index | `idx_body`, 1/12 granules |
| `hasAllTokens('hotel updated',['hotel','updated'])` | 1 |
| Add `tokenbf_v1(32768,3,0) GRANULARITY 1` to scratch table | Accepted on this version; not a performance comparison |

The text plans reported direct text-index virtual predicates; pair/body queries also appeared in automatic PREWHERE. Different table layouts yielded 12 versus 13 total granules; this is a plan receipt, not a speed ratio or capacity claim. No latency, ingestion throughput, disk overhead, concurrent-query or 10M/day qualification was performed. A first console-output encoding failure interrupted printing one plan; cleanup ran and the complete test was rerun with UTF-8 output.

Reproduction core (use only `trailmark.research_*`; credentials through the existing environment):

```sql
CREATE TABLE trailmark.research_pairs
(
  id UInt64,
  body String,
  attributes Map(LowCardinality(String), String),
  attribute_items Array(String) ALIAS arrayMap(
    (k,v) -> concat(toString(length(k)), ':', k, v),
    mapKeys(attributes), mapValues(attributes)),
  INDEX idx_pairs attribute_items TYPE text(tokenizer = array),
  INDEX idx_body body TYPE text(tokenizer = splitByNonAlpha)
)
ENGINE = MergeTree ORDER BY id SETTINGS index_granularity = 8192;
INSERT INTO trailmark.research_pairs
SELECT number, if(number=12345,'مرحبا hotel updated','ordinary'),
       map('metadata.plan',if(number=12345,'pro','free'))
FROM numbers(100000);
EXPLAIN indexes=1 SELECT id FROM trailmark.research_pairs
WHERE has(attribute_items, '13:metadata.planpro');
EXPLAIN indexes=1 SELECT id FROM trailmark.research_pairs
WHERE hasToken(body, 'مرحبا');
DROP TABLE trailmark.research_pairs;
```

The pair encoding uses **UTF-8 byte length** of the key, not JavaScript string length, to avoid ambiguity if either keys or values contain `=` or `:`. Prefer composing the token in SQL with `length({key:String})`. Native Map `keyValuePairs` is a future alternative from current docs; it was not tested here and should not be made a 26.2 compatibility requirement without version-specific verification.

## 7. Prioritized SPEC changes for implementers

### P0 — §4: index DDL and physical layout

Apply the following replacement inside the proposed CREATE TABLE; this is a spec diff, **not** an instruction to ALTER existing production data:

```diff
- timestamp DateTime64(3, 'UTC'),
- received_at DateTime64(3, 'UTC') DEFAULT now64(3),
+ timestamp DateTime64(3, 'UTC') CODEC(Delta, ZSTD(3)),
+ received_at DateTime64(3, 'UTC') DEFAULT now64(3) CODEC(Delta, ZSTD(3)),
- attributes Map(LowCardinality(String), String),
+ attributes Map(LowCardinality(String), String) CODEC(ZSTD(3)),
+ search_text String MATERIALIZED lowerUTF8(concat(
+   description, ' ', actor_name, ' ', tenant_name, ' ',
+   arrayStringConcat(target_names, ' '))) CODEC(ZSTD(3)),
+ attribute_items Array(String) ALIAS arrayMap(
+   (k,v) -> concat(toString(length(k)), ':', k, v),
+   mapKeys(attributes), mapValues(attributes)),
- INDEX idx_attr_keys mapKeys(attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
- INDEX idx_attr_vals mapValues(attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
- INDEX idx_text lower(concat(...)) TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 1
+ INDEX idx_attr_keys mapKeys(attributes) TYPE text(tokenizer = array),
+ INDEX idx_attr_items attribute_items TYPE text(tokenizer = array),
+ INDEX idx_text search_text TYPE text(tokenizer = splitByNonAlpha)
- PARTITION BY toYYYYMM(timestamp)
+ PARTITION BY toDate(timestamp)
```

Keep `ORDER BY (project_id,timestamp,event_id)`, granularity 8192, payload ZSTD(3), and initially keep the existing equality Bloom indexes for IDs/arrays until representative selectivity/storage tests justify replacing them. Do not add text/bloom indexes to every column indiscriminately. Daily partitions are the initial recommendation for the stated 10M+/day/project workload; measure part counts across project fan-out and late arrivals. Keep normal row TTL behavior, **do not copy** `ttl_only_drop_parts=1` while promising immediate per-project retention. TTL is a hard-cap safety net, not the immediate retention workflow.

Require 26.2+ in quickstart/startup checks. For an existing deployment, add/materialize indexes in a separately scheduled migration and measure write amplification; ADD INDEX alone does not index old parts. The exact combined Trailmark DDL/codecs have not been executed here; the index and pair expressions above have.

### P0 — §4: specify idempotency before choosing the final engine

Keep the proposed ReplacingMergeTree only as eventual physical compaction, with an explicit caveat: its identity is the full sorting key, including timestamp, and only within a partition. Reusing an event ID with a different timestamp will not replace the old row. `received_at` is a version, not an idempotency reservation. Result-page dedup cannot repair histogram/MV counts or duplicates across cursors.

Add an implementation gate: immutable project/event-ID identity, canonical event timestamp on retries, payload conflict detection, cross-request/cross-instance arbitration, bounded/documented retry horizon and crash recovery after ambiguous ClickHouse acknowledgement. Recommended direction is a durable ingest-batch receipt/reservation in Postgres, stable batch content/token on retry, and ClickHouse deduplication settings qualified together with dependent MVs on the supported version. A reservation alone is insufficient: test crash after insert/before receipt commit. Until that is implemented, document at-least-once storage and duplicate-sensitive aggregates; do not claim exactly-once audit counts. Do not change to plain MergeTree merely because HyperDX does.

### P0 — §5.1: typed grammar with stable semantics

Implement tokenizer → AST → validation → typed predicate compiler. Support implicit AND, quotes/escapes, leading `-`, and trailing `*` on field values first. Reject unsupported OR/parentheses with a clear syntax error until implemented; never silently reinterpret malformed input. Fix limits at 4096 input bytes, 64 terms and 16 nesting levels for the eventual boolean grammar. Map all core aliases through a static allowlist; unknown prefixes become parameterized attribute keys, never SQL identifiers.

| Input | Recommended predicate |
|---|---|
| `action:hotel.policy.updated` | `action = {value:String}` |
| `action:hotel.*` | `startsWith(action,{prefix:String})`, parameter `hotel.` |
| `actor:usr_42` | `actor_id = {value:String}` |
| `target:hotel_123` | `has(target_ids,{value:String})` |
| `attr.metadata.plan:pro` | `has(attribute_items,concat(toString(length({key:String})),':',{key:String},{value:String}))` |
| `attr.metadata.plan:pr*` | `mapContains(attributes,{key:String}) AND startsWith(attributes[{key:String}],{prefix:String})` |
| `denied` | `hasToken(search_text,lowerUTF8({token:String}))` |
| `"policy updated"` | indexed token conjunction plus `position(search_text,lowerUTF8({phrase:String})) > 0` |

Define unquoted core/attribute fields as case-sensitive exact/prefix comparisons; free text is case-insensitive. Define quoted free text as a contiguous literal phrase; add token prefilters only when extracting complete boundary-safe tokens cannot introduce false negatives. Punctuation-only phrases use the bounded residual scan. Never pass a multiword literal to hasToken. Tests must cover Arabic, mixed case, punctuation, underscore/dot, escapes, missing keys versus empty values, multibyte key length, conflicting pairs and wildcard literals. Preserve raw payload separately; searchable text currently excludes arbitrary payload/metadata values by design, which must be stated in the UI/docs.

For exact attributes, presence is required, including an empty value; negative equality includes missing keys (negate the whole positive predicate). This differs deliberately from HyperDX's missing-is-empty map equality. If typed native Map lookup is used instead, include mapContains to preserve the same semantics. The pair index handles exact lookup; it does not guarantee cheap prefixes or negative-only search.

Every search receives this server-enforced outer envelope, independent of the AST:

```sql
SELECT timestamp, event_id, action, description -- explicit list; payload on detail
FROM events
PREWHERE project_id = {project:String}
  AND timestamp >= {from:DateTime64(3)}
  AND timestamp < {to:DateTime64(3)}
WHERE /* compiled predicate, fully parenthesized */
  AND (timestamp,event_id) < ({cursor_ts:DateTime64(3)},{cursor_id:String})
ORDER BY timestamp DESC,event_id DESC
LIMIT {fetch:UInt32}
SETTINGS max_execution_time=5, max_rows_to_read=5000000,
  max_bytes_to_read=536870912, max_memory_usage=536870912,
  read_overflow_mode='throw', timeout_overflow_mode='throw';
```

Omit cursor predicate on the first page; fetch `pageSize+1`, default 100, maximum 1000. These are proposed starting budgets, not capacity measurements. Freeze the upper timestamp in a signed/project-bound cursor and encode milliseconds losslessly. Bind project from authorization. Budget/cancellation errors must not masquerade as an empty result. For totals, cap a subquery at 10,001 to establish `10k+`; a timeout alone cannot prove that lower bound, so return `unknown`/`timed_out` instead.

### P0 — §4: retention-safe derived data

Replace all-time `entities` and `attribute_keys` aggregates with daily buckets in the sorting key. Store first/last timestamps as mergeable min/max and latest labels as `argMax` by event timestamp, not merge-order-dependent `anyLast`. Query across retained buckets; partial oldest-day cutoffs require rebuilding that bucket or querying raw retained data. A single max(last_seen) cannot remove expired contributions/samples from an all-time aggregate. Insert-triggered MVs do not retract rows when source events are deleted/replaced. Retention lowering/project deletion must explicitly purge or rebuild **every** derived table/cache and wait for the defined completion condition before reporting success. Include duplicate ingestion, replay, partial-day purge and source/rollup count reconciliation in acceptance.

### P1 — §4/§5.1: autocomplete, histograms and facets

Use a project/day/field/value SummingMergeTree metadata rollup for approved low-cardinality values, with counts and latest timestamps; cap which arbitrary fields/values are eligible to avoid expanding every event into hundreds of metadata rows. Keep a separate key directory. Replace `groupUniqArray(5)` as the sole suggestion source: it cannot provide relevant prefix completions or top values beyond five arbitrary samples.

Autocomplete endpoint: authenticated project, last-24h default, retained-range maximum, normalized prefix, limit 20; debounce 300 ms, cancel stale requests, cache 30 seconds keyed by project/range/field/prefix, query deadline 1 second and strict memory/read budgets. Fetch keys first and values only for the active field. Rank metadata values by summed counts then deterministic value order; distinguish suggestions from filtered facet counts. Optional Fuse.js may filter the bounded returned list; no Orama or browser corpus is needed. Keep entity-name fuzzy matching confined to a bounded entity directory, never the raw event table.

Histograms use validated UTC intervals from a fixed ladder (1s/10s/1m/5m/1h/1d), target at most 300 buckets, zero-fill the requested range, and use the same predicate compiler as search. Use `events_by_minute` only when its dimensions can represent every filter and bucket boundaries align; otherwise query raw data with budgets. Facet top values should sum rollup counts where eligible, otherwise bounded GROUP BY/count over raw data. Mark sampled/incomplete results explicitly. Do not copy HyperDX's full-row sampling scan as the default optimization.

### P1 — ingestion and qualification

Retain HTTP caps (1000 events/5 MB; 256 KB per event), SDK row/byte/time flush limits, bounded concurrent inserts and retry backoff with jitter. Preserve wait-for-async-flush acknowledgement. Observe rows/bytes per batch, parts created, rejected inserts, retry ambiguity and insert-to-search delay. Do not add a lossy sampler to audit ingestion.

Before raising scale claims, run representative fictional projects with skewed actors/actions, high-cardinality arbitrary attributes, Arabic text, correlated and uncorrelated values, duplicate retries and late timestamps. Capture `EXPLAIN indexes=1`, query-log read_rows/read_bytes, p50/p95/p99, storage/part counts and ingest throughput under concurrency. Compare the proposed text/pair indexes with the baseline Bloom DDL at equal data/retention. This research proves syntax and selective pruning on the local version, not production readiness.
