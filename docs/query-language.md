# Query language and SQL expressions

Logbird searches one authorized project within a half-open UTC time range. The default range is the last 24 hours. All query language values and attribute keys are ClickHouse parameters. SQL mode accepts a boolean expression on console endpoints only.

## Query language (lang=query, default)

| Construct | Example | Meaning |
| --- | --- | --- |
| Exact | action:hotel.policy.updated | Exact, case-sensitive value |
| Prefix | action:hotel.* | Trailing wildcard; internal stars are literal |
| Negation | -env:staging or NOT env:staging | Exclude matches |
| Presence | impersonator:* -tenant:* or _exists_:impersonator | Non-empty / missing (numeric/date columns always present) |
| Text | "free text" bare words | Search description, actor, tenant and target names; adjacency AND |
| Boolean | (a OR b) AND NOT c | AND binds more tightly than OR; parentheses override |
| Number | attempt:>2 conformance:<=50 | >, >=, <, <= on number/date fields or attributes |
| Range | duration_ms:[100 TO 500} | Inclusive [ ], exclusive { }; mixed brackets allowed |
| Open range | attempt:[2 TO *] | Asterisk omits that bound |
| Date | occurredAt:>2026-11-01 | UTC date or ISO-8601 with zone, e.g. 2026-11-03T12:00:00Z |
| Regex | action:/booking\.(created\|cancelled)/ | Whole-value anchored RE2; escape slash as \/; no lookaround/backreferences |
| Value group | action:(booking.created OR booking.cancelled) | Scalar exact values compile to IN; negation excludes the group |
| Prefix group | action:(booking.* OR hotel.*) | OR of prefix matches |
| Attribute | metadata.channel:whatsapp | Unknown keys are attribute lookups; attr. and attributes. prefixes are aliases |

Arrays (target, target.type, target.name, changes.field) match any element. Attribute comparisons convert strings with toFloat64OrNull, or parseDateTime64BestEffortOrNull for date bounds; invalid conversions do not match. String fields do not support ordered comparisons. Quote values containing whitespace or grammar punctuation; quoted strings accept backslash escapes.

Examples retained from v0:

```text
action:hotel.policy.updated
action:hotel.*
outcome:failure -env:staging
actor:usr_42 actor.type:user actor.name:"Lina Haddad"
tenant:biz_7 tenant.name:"Azure Hotels" executor:crm-worker executor.type:worker
executor.name:"CRM worker" actor.email:lina@example.com impersonator:usr_1
parent:evt_123 job:456
target:hotel_123 target.type:hotel operation:op_101 request:req_abc trace:abc source:channel-manager
attr.metadata.plan:pro
impersonator:* -tenant:*
severity:critical category:hotel id:evt_123
"free text" bare words
(a OR b) c
```

Date bounds also accept `occurredAt:>now-7d` and `occurredAt:[now-24h TO now]`.
Units are s/m/h/d/w; + and - offsets are supported, optionally followed by `/d`
(round down to UTC midnight, e.g. now-7d/d). A compilation uses one clock instant;
resolved dates are parameters. `NOT _exists_:field` means missing.

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

Subqueries, UNION, WITH, SETTINGS, FORMAT injection, table functions, arrayJoin, dictionaries, external reads, project_id, arbitrary parameters, comments, semicolons, heredoc strings and quoted identifiers (backticks or double quotes) are rejected outside single-quoted string literals; inside a string literal any character is fine (`description LIKE '%#%'`). The outer project/time conditions remain effective even for 1 OR 1. Successful validations cache for 30 seconds, at most 256 expressions per client. Errors are never cached.

Every SQL request uses the separate logbird_query account; missing credentials cause 503 sql_mode_unavailable. There is no privileged fallback. The read-key /v1 API rejects SQL with 422. Entity profiles and workspace activity preserve their authorized scope. Export pages retain the filter and use throwing limits; a mid-stream limit terminates the stream, so clients must treat a failed stream as incomplete. Exports do not silently truncate, but pagewise limits are not a total-export budget.

The profile enforces readonly=2 CONST, allow_ddl=0 CONST, 10 seconds per statement, 5 million rows read, 1 GiB each for bytes read and memory, 100,000 result rows with throw overflow, 64 KiB total server statement size, AST depth 128 and four threads. Every listed resource and safety setting is CONST, so neither larger values nor zero (unlimited) can bypass the budget. readonly=2 allows the request custom setting while still refusing writes and DDL. These provide room for the 300k-event demo while bounding a single request. SELECT grants cover events and the three rollups used by overview/entity paths. No write or external-source grants are added.

The isolation layers are: (1) the query language compiles to parameterized SQL; (2) SQL mode uses the string-aware lexical scan, EXPLAIN AST baseline comparison and identifier/function allowlists above; (3) the separate readonly account has CONST limits and SELECT-only grants; (4) database row policies on `logbird.events`, `events_by_minute`, `entities` and `attribute_keys` enforce `project_id = getSetting('SQL_logbird_project')` for `logbird_query`. The server binds the authorized project on **every query** via `clickhouse_settings`, including rollup reads and each export page. EXPLAIN AST uses a validation-only project. Bindings are per request, never shared mutable client/session state. A missing setting raises UNKNOWN_SETTING on table reads. A filter bypass such as `1 OR 1` cannot expose another project's rows.

The database trusts the server's binding: anyone holding the restricted database credentials can deliberately choose another project setting. This protects against omitted or broadened SQL filters; it does not replace HTTP authorization or protect against stolen database credentials, privileged administrators, or arbitrary SQL that overrides the trusted binding. Keep the AST guard (including its SETTINGS rejection) and credentials private.

Companion `logbird_unrestricted` policies use `USING 1 TO ALL EXCEPT logbird_query` to preserve other users' existing access across ClickHouse configurations (policies do not themselves grant SELECT). A disposable-table integration test confirms the main user sees both rows without a companion on local 26.9.19.9 and still sees both with it; all four real tables also retain main-client visibility of both fictional projects. No shared server configuration changes are needed. On local ClickHouse 26.9.19.9 the `custom_settings_prefixes` server-settings query returns no row; an actual `getSetting` round trip confirms the built-in `SQL_` prefix works. Provisioning fails if that round trip is unsupported.

Self-hosters must re-provision before enabling the updated SQL readers (during a maintenance window, since access-control DDL is not transactional):

```sh
pnpm --filter @logbird/clickhouse create-query-user
```

Run from the repository root with its configured `.env` and a main user allowed to manage Logbird users, profiles, row policies and SELECT grants. The script upgrades existing profiles/policies idempotently and preserves credentials. It compares main-user table counts before/after; concurrent ingestion may require a quiet retry. Restart the server after provisioning. Tests use isolated fictional project IDs, retain their event fixtures, and remove only their own temporary semantics-probe table/policies.

**Shared-server limitation:** ClickHouse implicitly permits some system metadata reads (observed system.tables, system.databases, system.settings) regardless of these explicit table grants. Direct system.users/system.numbers reads, other database data and writes are denied. The expression AST guard blocks all system-table access over HTTP. The instance-level access_control_improvements.select_from_system_db_requires_grant setting tightens system access, but ClickHouse still exempts tables/columns/databases and several constant tables. Therefore blanket direct-client denial of every system table cannot be established with the requested user grants alone. See [ClickHouse's access-control configuration](https://github.com/ClickHouse/ClickHouse/blob/master/programs/server/config.xml#L799-L822). This setup script deliberately does not change shared server configuration.

A free-form SQL console is out of scope for Logbird Cloud; it may come later as a self-host instance-admin feature.

## Limits and errors

Query language: 4096 UTF-8 bytes, 64 terms and 16 nesting levels. SQL: 4096 UTF-8 bytes and 64 AST expression levels, plus the ClickHouse parser limits. Invalid expressions return HTTP 422 with code invalid_query and details {lang, reason, start, end, hint}. Offsets are half-open UTF-16 code units; null means no specific source span. Reasons: syntax, unknown_field, not_allowed, type, too_complex, limit. For example attempt:>abc reports type with [9,12) and hint "attempt is a number". Storage resource exhaustion reports limit with a hint to narrow the time range/filter. Infrastructure failures remain 503.

## Autocomplete

GET /api/projects/:projectId/suggest?field=actor&prefix=ra&limit=10 returns
{field,values:[{value,label,count}],complete}. Prefix is case-insensitive contains matching
over value and label; ranking is count descending, then value. Optional q/lang/from/to
scope values to the current query (including the suggested field's own predicate).
SQL mode uses the restricted client and the same AST validation and project binding.
With no query/time scope, entities and low-cardinality fields keep their rollup fast paths.
Attributes and column fields, and all scoped requests, count actual values in at most
50,000 most recent stored rows in the requested range (default seven days). Sampling
precedes query filtering, so rare values outside the sample may be omitted. Counts are
per stored row within that sample, not a key's total frequency or deduplicated event counts.
`complete` is true only if the scan was exhaustive for that window and every matching
value fits within limit; it is conservatively false when the row bound is reached.
Unsupported sources return an empty complete list. Rollups can be incomplete after a
failed retention rebuild; the retention status endpoint reports failures.

KQL-style syntax errors include optional `details.replacement: {start,end,text}` with
UTF-16 offsets. Applying that edit converts `f = v`, `f != v`, `!f:v`, `&&` or `||` to
Logbird syntax. Operators inside quoted values and regexes remain literal. SQL syntax
errors from validation and execution map ClickHouse byte positions to UTF-16 spans.

## Query bar (console)

The explorer's query bar suggests as you type, at any caret position; accepting a suggestion replaces only the token under the caret.

- **On focus (empty bar):** recent queries for this project (per browser, at most 20, newest first, removable with × or Shift+Delete), the project's saved views, then fields — the ones the project actually uses first, with type, coverage and description.
- **Field names:** prefix, word-segment (`name` → `actor.name`), substring and fuzzy (`tnm` → `tenant.name`) matches over core fields, aliases and attribute keys. Free text of three or more letters also searches entity names and actions (`rawd` → `tenant:biz_2` "Rawda Suites").
- **After `field:`:** values from `/suggest` ranked by count (entity ids show their display names), then value operators: `*` present, `"…"` exact, `(a OR b)` any of, `/regex/`; numbers get `>` `>=` `<` `<=` `[a TO b]`; dates get quick ranges (last 24 hours / 7 / 30 days). Values with spaces or any of `: ( ) [ ] { } < > "` are quoted. Value lists are cached per field and prefix, debounced while typing, prefetched while a field is highlighted, and filtered locally when the unfiltered list is already complete.
- **After a complete term:** `OR`, `AND`, `NOT`, `-` and `( )` lead, then fields; inside `field:( … )` after a member, `OR` leads.
- **Syntax hint row:** one line under the bar says what the current token expects (`attempt · number — attempt:>2 …`, the range / regex / phrase rules, or in SQL mode the signature of the function around the caret with the current argument emphasised).
- **Familiar spellings:** Lucene `_exists_:f` → `f:*`, KQL `f = v` / `f != v` / `f >= 10` → `f:v` / `-f:v` / `f:>=10`, `f: v` → `f:v`, `!f:v` → `-f:v`, `&&` / `||` → `AND` / `OR`. They are underlined, offered as the first suggestion, and converted when the query runs (with Undo). Lower-case `and` / `or` / `not` are only flagged, since they may be words you are searching for.
- **SQL mode:** columns, `attributes['…']` keys (also found by the key's own name: `queue` → `attributes['metadata.queue']`), functions with signatures, comparison operators after a column, `AND` / `OR` after an operand, values after `=`, `IN (`, `has(col,` (quoted for you), and relative times after `timestamp >`.
- **Keyboard:** ↑/↓ move, Tab completes (and never moves focus while you compose), Enter runs (or picks a row you moved to), Ctrl/⌘+Enter always runs, Esc closes the panel, Ctrl+Space opens it, `/` focuses the bar.

## Local verification

See [recorded HTTP evidence](search-v2-evidence.jsonl) and scripts/search-v2-proof.ts. Search total saturates at 10001 (the existing count cap); this is not an exact count above the cap. Run the HTTP tests with SEARCH_V2_HTTP=1, SERVER_URL=http://127.0.0.1:4631, APP_URL=http://localhost:4630 and the server running on port 4631. The ClickHouse integration tests require the root environment. Tests only create fictional records; HTTP security fixtures are retained with a Search v2 security name for inspection.

See [event exports](exports.md) for complete original payloads, normalized CSV/JSONL, versioned schemas, fixed query clocks and file-to-record verification.
