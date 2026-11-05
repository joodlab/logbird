# Query language and SQL expressions

Trailmark searches one authorized project within a half-open UTC time range. The default range is the last 24 hours. All query language values and attribute keys are ClickHouse parameters. SQL mode accepts a boolean expression on console endpoints only.

## Query language (lang=query, default)

| Construct | Example | Meaning |
| --- | --- | --- |
| Exact | action:hotel.policy.updated | Exact, case-sensitive value |
| Prefix | action:hotel.* | Trailing wildcard; internal stars are literal |
| Negation | -env:staging or NOT env:staging | Exclude matches |
| Presence | impersonator:* -tenant:* | Non-empty / missing (numeric/date columns always present) |
| Text | "free text" bare words | Search description, actor, tenant and target names; adjacency AND |
| Boolean | (a OR b) AND NOT c | AND binds more tightly than OR; parentheses override |
| Number | attempt:>2 conformance:<=50 | >, >=, <, <= on number/date fields or attributes |
| Range | duration_ms:[100 TO 500} | Inclusive [ ], exclusive { }; mixed brackets allowed |
| Open range | attempt:[2 TO *] | Asterisk omits that bound |
| Date | occurredAt:>2026-11-01 | UTC date or ISO-8601 with zone, e.g. 2026-11-03T12:00:00Z |
| Regex | action:/booking\.(created|cancelled)/ | Whole-value anchored RE2; escape slash as \/; no lookaround/backreferences |
| Value group | action:(booking.created OR booking.cancelled) | Scalar exact values compile to IN; negation excludes the group |
| Prefix group | action:(booking.* OR hotel.*) | OR of prefix matches |
| Attribute | metadata.channel:whatsapp | Unknown keys are attribute lookups; attr. and attributes. prefixes are aliases |

Arrays (target, target.type, target.name, changes.field) match any element. Attribute comparisons convert strings with toFloat64OrNull, or parseDateTime64BestEffortOrNull for date bounds; invalid conversions do not match. String fields do not support ordered comparisons. Quote values containing whitespace or grammar punctuation; quoted strings accept backslash escapes.

Examples retained from v0:

```text
action:hotel.policy.updated
action:hotel.*
outcome:failure -env:staging
actor:usr_42 actor.type:user actor.name:"Raed B"
tenant:biz_7 tenant.name:"Azure Hotels" executor:crm-worker executor.type:worker
executor.name:"CRM worker" actor.email:raed@example.com impersonator:usr_1
parent:evt_123 job:456
target:hotel_123 target.type:hotel operation:op_101 request:req_abc trace:abc source:joodbooking
attr.metadata.plan:pro
impersonator:* -tenant:*
severity:critical category:hotel id:evt_123
"free text" bare words
(a OR b) c
```

## Field catalog

| Field | Aliases | Type | SQL column | Suggest source |
| --- | --- | --- | --- | --- |
| action |  | string | action | rollup |
| category |  | string | category | column |
| outcome |  | string | outcome | rollup |
| severity |  | string | severity | column |
| env | environment | string | environment | rollup |
| actor | actor.id | string | actor_id | entities |
| actor.type |  | string | actor_type | rollup |
| actor.name |  | string | actor_name | entities |
| actor.email |  | string | actor_email | column |
| impersonator |  | string | impersonator_id | column |
| tenant |  | string | tenant_id | entities |
| tenant.name |  | string | tenant_name | entities |
| executor |  | string | executor_id | entities |
| executor.type |  | string | executor_type | rollup |
| executor.name |  | string | executor_name | entities |
| job |  | string | job_id | none |
| attempt |  | number | job_attempt | none |
| target |  | array | target_ids | entities |
| target.type |  | array | target_types | entities |
| target.name |  | array | target_names | none |
| changes.field |  | array | changes_fields | none |
| operation |  | string | operation_id | none |
| parent |  | string | parent_event_id | none |
| request |  | string | request_id | none |
| trace |  | string | trace_id | none |
| source |  | string | source | column |
| id |  | string | event_id | none |
| ip |  | string | ip | none |
| conformance |  | number | conformance | none |
| occurredAt | timestamp | date | timestamp | none |
| receivedAt |  | date | received_at | none |
| description |  | text | description | none |

## SQL mode (lang=sql)

Examples:

```sql
job_attempt > 2
attributes['metadata.channel'] = 'whatsapp'
has(target_types, 'booking')
arrayExists(x -> startsWith(x, 'bk_'), target_ids)
toHour(timestamp) BETWEEN 9 AND 17
match(action, '^booking\\.')
outcome IN ('failure', 'denied')
```

Allowed identifiers (case-sensitive): `event_id`, `timestamp`, `received_at`, `environment`, `action`, `category`, `outcome`, `severity`, `description`, `actor_type`, `actor_id`, `actor_name`, `actor_email`, `impersonator_id`, `impersonator_name`, `executor_type`, `executor_id`, `executor_name`, `job_id`, `job_attempt`, `tenant_id`, `tenant_name`, `source`, `target_types`, `target_ids`, `target_names`, `changes_fields`, `changes_before`, `changes_after`, `operation_id`, `parent_event_id`, `request_id`, `trace_id`, `ip`, `user_agent`, `attributes`, `conformance`, `schema_version`, `sdk`.

Allowed functions (case-sensitive AST names; SQL operators are rewritten by ClickHouse):

`and`, `or`, `not`, `xor`, `equals`, `notEquals`, `less`, `greater`, `lessOrEquals`, `greaterOrEquals`, `in`, `notIn`, `like`, `notLike`, `ilike`, `notILike`, `isNull`, `isNotNull`, `if`, `multiIf`, `coalesce`, `ifNull`, `tuple`, `array`, `plus`, `minus`, `multiply`, `divide`, `intDiv`, `modulo`, `negate`, `abs`, `round`, `floor`, `ceil`, `least`, `greatest`, `length`, `lengthUTF8`, `empty`, `notEmpty`, `lower`, `upper`, `lowerUTF8`, `upperUTF8`, `trim`, `trimBoth`, `trimLeft`, `trimRight`, `concat`, `substring`, `substringUTF8`, `startsWith`, `endsWith`, `position`, `positionCaseInsensitive`, `positionUTF8`, `positionCaseInsensitiveUTF8`, `match`, `extract`, `multiSearchAny`, `multiMatchAny`, `hasToken`, `hasTokenCaseInsensitive`, `splitByChar`, `replaceAll`, `replaceRegexpAll`, `reverse`, `domain`, `cutQueryString`, `has`, `hasAny`, `hasAll`, `indexOf`, `countEqual`, `arrayElement`, `arrayExists`, `arrayAll`, `arrayCount`, `arrayFilter`, `arrayMap`, `arrayStringConcat`, `lambda`, `mapContains`, `mapKeys`, `mapValues`, `JSONHas`, `JSONExtractString`, `JSONExtractInt`, `JSONExtractFloat`, `JSONExtractBool`, `JSONLength`, `JSONType`, `toString`, `toInt32`, `toInt64`, `toUInt32`, `toUInt64`, `toFloat64`, `toInt64OrNull`, `toFloat64OrNull`, `toInt64OrZero`, `toFloat64OrZero`, `toDate`, `toDateTime`, `toDateTime64`, `parseDateTimeBestEffort`, `parseDateTimeBestEffortOrNull`, `parseDateTime64BestEffortOrNull`, `CAST`, `_CAST`, `toTypeName`, `now`, `now64`, `today`, `yesterday`, `toStartOfMinute`, `toStartOfHour`, `toStartOfDay`, `toStartOfWeek`, `toStartOfMonth`, `toYYYYMM`, `toYYYYMMDD`, `toHour`, `toMinute`, `toDayOfWeek`, `toDayOfMonth`, `toMonth`, `toYear`, `dateDiff`, `addDays`, `addHours`, `addMinutes`, `subtractDays`, `subtractHours`, `subtractMinutes`, `toIntervalSecond`, `toIntervalMinute`, `toIntervalHour`, `toIntervalDay`, `toIntervalWeek`, `toIntervalMonth`, `formatDateTime`, `IPv4StringToNum`, `isIPv4String`, `isIPAddressInRange`, `toIPv4`, `toIPv6`.

### Security model

The server validates an events SELECT wrapper containing project_id and timestamp bounds using ClickHouse EXPLAIN AST. It compares the entire wrapper to a baseline AST, replacing only the expression subtree, then recursively allows only literals, catalog identifiers, expression lists and allowlisted functions. Lambda names exist only in their lambda scope. The client appends a fixed FORMAT TabSeparatedRaw identifier; that exact node is part of the baseline. Unsupported AST shapes fail closed. This tree format was verified against ClickHouse 26.9.19.9. Query templates retain their own SELECTs, joins and aggregates; only the validated expression enters their parenthesized filter slot.

Subqueries, UNION, WITH, SETTINGS, FORMAT injection, table functions, arrayJoin, dictionaries, external reads, project_id, arbitrary parameters, comments and semicolons are rejected. The outer project/time conditions remain effective even for 1 OR 1. Successful validations cache for 30 seconds, at most 256 expressions per client. Errors are never cached.

Every SQL request uses the separate trailmark_query account; missing credentials cause 503 sql_mode_unavailable. There is no privileged fallback. The read-key /v1 API rejects SQL with 422. Entity profiles and workspace activity preserve their authorized scope. Export pages retain the filter and use throwing limits; a mid-stream limit terminates the stream, so clients must treat a failed stream as incomplete. Exports do not silently truncate, but pagewise limits are not a total-export budget.

The profile enforces readonly=1, allow_ddl=0, 10 seconds per statement, 5 million rows read, 1 GiB each for bytes read and memory, 100,000 result rows with throw overflow, 64 KiB total server statement size, AST depth 128 and four threads. These provide room for the 300k-event demo while bounding a single request. SELECT grants cover events and the three rollups used by overview/entity paths. No write or external-source grants are added.

**Shared-server limitation:** ClickHouse implicitly permits some system metadata reads (observed system.tables, system.databases, system.settings) regardless of these explicit table grants. Direct system.users/system.numbers reads, other database data and writes are denied. The expression AST guard blocks all system-table access over HTTP. Complete direct-client metadata denial additionally requires the instance operator's access_control_improvements.select_from_system_db_requires_grant server configuration; this setup script deliberately does not change shared server configuration.

A free-form SQL console is out of scope for Trailmark Cloud; it may come later as a self-host instance-admin feature.

## Limits and errors

Query language: 4096 UTF-8 bytes, 64 terms and 16 nesting levels. SQL: 4096 UTF-8 bytes and 64 AST expression levels, plus the ClickHouse parser limits. Invalid expressions return HTTP 422 with code invalid_query and details {lang, reason, start, end, hint}. Offsets are half-open UTF-16 code units; null means no specific source span. Reasons: syntax, unknown_field, not_allowed, type, too_complex, limit. For example attempt:>abc reports type with [9,12) and hint "attempt is a number". Storage resource exhaustion reports limit with a hint to narrow the time range/filter. Infrastructure failures remain 503.

## Autocomplete

GET /api/projects/:projectId/suggest?field=actor&prefix=ra&limit=10 returns {field,values:[{value,label,count}]}. Prefix is case-insensitive contains matching over value and label. Results rank by count, then value. Entities use the entities rollup (display name labels); low-cardinality values use events_by_minute over seven days; column values scan at most 50,000 recent events in seven days. Attribute samples use attribute_keys; count is the key's total frequency, not an individual sampled value frequency. Sources are approximate rollups and can include pre-retention history until rebuilt. Unsupported suggestion sources return an empty list. Authorization precedes every lookup.

## Local verification

See [recorded HTTP evidence](search-v2-evidence.jsonl) and scripts/search-v2-proof.ts. Search total saturates at 10001 (the existing count cap); this is not an exact count above the cap. Run the HTTP tests with SEARCH_V2_HTTP=1, SERVER_URL=http://127.0.0.1:4631, APP_URL=http://localhost:4630 and the server running on port 4631. The ClickHouse integration tests require the root environment. Tests only create fictional records; HTTP security fixtures are retained with a Search v2 security name for inspection.
