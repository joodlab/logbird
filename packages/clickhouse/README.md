# @trailmark/clickhouse

Pure library, no HTTP. Requires ClickHouse 26.2+ (native text indexes). Run
`pnpm ch:migrate` from the root with the gitignored `.env` populated. The factory
reads CLICKHOUSE_URL, CLICKHOUSE_DATABASE, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD.
It never creates or resets a database. Ordered SQL files are recorded in
`migrations`; DDL is idempotent for restart after partial failure. Run migrations
from one deployment owner, not concurrently from application replicas.

## API

All query input objects are parsed contract schemas. IDs come from the authorized
server context. Workspace streams use `ws:<organizationId>` as the project ID.

```ts
createClickHouseClient(env = process.env): ClickHouseClient
migrate(ch): Promise<void>
normalizeEvent(input: unknown, ctx: { projectId: string; receivedAt: Date; sdk?: string }):
  { ok: true; row: EventRow; id: string } | { ok: false; reason: string }
insertEvents(ch, rows: EventRow[]): Promise<void>
parseQuery(q?: string): Term[]
compileQuery(q?: string | Term[]): { sql: string; params: Record<string, string> }
searchEvents(ch, projectId, q: SearchQuery): Promise<SearchResponse>
getEvent(ch, projectId, eventId): Promise<EventDetail | null>
liveEvents(ch, projectId, q: { since: string; q?: string; limit: number }): Promise<AuditEvent[]>
histogram(ch, projectId, q: HistogramQuery): Promise<HistogramResponse>
facets(ch, projectId, q: FacetQuery): Promise<FacetResponse>
overview(ch, projectId, q: RangeQuery): Promise<OverviewResponse>
listEntities(ch, projectId, q: EntityListQuery): Promise<EntityListResponse>
entityProfile(ch, projectId, kind: EntityKind, id, q: RangeQuery): Promise<EntityProfile | null>
listFields(ch, projectId, q: RangeQuery): Promise<FieldsResponse>
operationEvents(ch, projectId, operationId): Promise<AuditEvent[]>
exportEvents(ch, projectId, q: RangeQuery & { format: 'csv' | 'jsonl' }): AsyncGenerator<string>
projectStats(ch, projectIds: string[]): Promise<Record<string, {lastEventAt: string | null; eventsLast24h: number}>>
purgeProject(ch, projectId, before?: Date): Promise<void>
```

HistogramQuery, FacetQuery, EntityListQuery, EntityListResponse and FieldsResponse
above refer to inferred contract schema types; the contracts package does not
export named types for them. Times are UTC; ranges are half-open. Missing detail
or entity returns null. Parent traversal stops at a missing parent, a cycle or
100 ancestors. CSV exports id/timestamp/action/outcome/description; JSONL exports
the full normalized contract event (raw payload is fetched separately in detail).

## Schema and semantics

The base schema follows SPEC §4. Project-first ordering and monthly partitions
are retained for this initial dataset; daily partitions need qualification at
the stated 10M/day workload. Migration 003 follows the HyperDX research's named
UTF-8 text column and length-prefixed attribute-pair text index. Existing Bloom
indexes remain pending write/storage benchmarks. Raw payload stays ZSTD compressed.
Search first selects narrow page keys, then fetches only those events, excluding
payload. All user terms, map keys, cursors and project IDs are bound parameters.
Exact attributes require presence, including empty values. Free words are
case-insensitive tokens; punctuation/phrases use a contiguous literal scan.
OR/parentheses are rejected in this initial AND-only grammar (64 terms, 4096 bytes).

Search totals are exact through 10,000 and return **10001 meaning 10k+** above
that threshold. The bounded distinct subquery has a one-second guard; timeout
propagates, never fabricates a successful count. Other reads have ten-second
guards. The contract currently has no total-status field.

Minute rollups drive the ingestion sparkline. Filtered charts and KPIs read raw
columns because arbitrary filters and partial minutes cannot be represented by
the low-cardinality rollup. Entity directories use the aggregate table. Entity
and attribute aggregates remain all-time: purge deletes and rebuilds only the
affected project's aggregates from retained rows, including partial-day cutoffs.
This trades purge cost for exact retained contributions without a schema rewrite.
**The server must serialize ingestion and purge for a project**, across replicas,
and keep the project unavailable until rebuild succeeds. These multi-table
operations are not transactional. Full project deletion deletes every derived row.
Lightweight deletes wait for completion; no shared table is dropped/truncated.

ReplacingMergeTree compacts identical (project,timestamp,id) keys eventually.
SDK retries keep IDs and timestamps stable, but this library does not provide
cross-instance ingest receipts or immutable ID conflict arbitration. Inserts and
MV counts are **at least once**: duplicates may inflate aggregates before/after
merges because views do not retract. The server must add durable arbitration
before claiming exactly-once counts. Search dedupes page keys; no FINAL hot path.

## Verification

`pnpm test` runs units. `node --env-file=.env node_modules/vitest/vitest.mjs run`
also runs the real ClickHouse contract test, with UUID-isolated test projects
cleaned up in finally. No other databases are touched.
