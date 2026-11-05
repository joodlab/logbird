import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Query languages                                                     */
/* ------------------------------------------------------------------ */

/**
 * `query` – the Trailmark query language (Lucene-like, docs/SPEC.md §5.1). Default everywhere.
 * `sql`   – a ClickHouse boolean WHERE expression only. The server wraps it in its own
 *           `SELECT … FROM events WHERE project_id = {p} AND timestamp BETWEEN … AND (<expr>)`, validates it with
 *           `EXPLAIN AST` against SQL_ALLOWED_COLUMNS / SQL_ALLOWED_FUNCTIONS and runs it as the restricted
 *           `trailmark_query` ClickHouse user. Accepted on console (`/api/*`) endpoints only; `/v1/*` rejects it.
 *           A free-form SQL console is intentionally out of scope (docs/query-language.md).
 */
export const QUERY_LANGS = ['query', 'sql'] as const;
export const queryLangSchema = z.enum(QUERY_LANGS);
export type QueryLang = z.infer<typeof queryLangSchema>;

/**
 * `invalid_query` (HTTP 422) error details. Offsets are UTF-16 code-unit indexes into `q` (what JS strings and
 * editors use), half-open [start, end). `start === end` points between characters (e.g. "expected value here").
 */
export const QUERY_ERROR_REASONS = [
  'syntax', // cannot be parsed
  'unknown_field', // sql: identifier not in SQL_ALLOWED_COLUMNS (query lang treats unknown fields as attributes)
  'not_allowed', // sql: function/construct outside the allowlist (subquery, table function, SETTINGS, arrayJoin…)
  'type', // value does not fit the field (e.g. attempt:>abc, bad date, invalid regex)
  'too_complex', // byte/term/nesting limits
  'limit', // execution hit a resource limit (rows read, memory, time) – narrow the range or the filter
] as const;
export const queryErrorDetailsSchema = z.object({
  lang: queryLangSchema,
  reason: z.enum(QUERY_ERROR_REASONS),
  start: z.number().int().nullable(),
  end: z.number().int().nullable(),
  /** Short fix suggestion, e.g. 'Use attempt:>2 or attempt:[2 TO 5]'. */
  hint: z.string().nullable(),
  replacement: z.object({ start: z.number().int(), end: z.number().int(), text: z.string() }).optional(),
});
export type QueryErrorDetails = z.infer<typeof queryErrorDetailsSchema>;

/* ------------------------------------------------------------------ */
/* Field catalog (autocomplete + docs; query lang and SQL mode)        */
/* ------------------------------------------------------------------ */

export const QUERY_FIELD_TYPES = ['string', 'number', 'date', 'array', 'text'] as const;
export type QueryFieldType = (typeof QUERY_FIELD_TYPES)[number];

export interface QueryFieldInfo {
  /** Key used in the query language (`actor:usr_1`). */
  key: string;
  aliases?: readonly string[];
  type: QueryFieldType;
  /** Underlying events column, which is also the identifier to use in SQL mode. */
  column: string;
  description: string;
  /** Where value autocomplete comes from (GET …/suggest). `none` = no suggestions. */
  suggest: 'entities' | 'rollup' | 'column' | 'none';
}

/**
 * Core fields. Anything else (`metadata.channel`, `attr.metadata.channel`, `attributes.foo.bar`) is an attribute
 * lookup; attribute values compare as strings, or as numbers/dates when used with comparisons or ranges.
 */
export const QUERY_FIELDS: readonly QueryFieldInfo[] = [
  { key: 'action', type: 'string', column: 'action', description: 'What happened, e.g. booking.cancelled', suggest: 'rollup' },
  { key: 'category', type: 'string', column: 'category', description: 'First segment of the action', suggest: 'column' },
  { key: 'outcome', type: 'string', column: 'outcome', description: 'success, failure, denied, partial, unknown', suggest: 'rollup' },
  { key: 'severity', type: 'string', column: 'severity', description: 'info, notice, warning, critical', suggest: 'column' },
  { key: 'env', aliases: ['environment'], type: 'string', column: 'environment', description: 'Environment', suggest: 'rollup' },
  { key: 'actor', aliases: ['actor.id'], type: 'string', column: 'actor_id', description: 'Who caused it', suggest: 'entities' },
  { key: 'actor.type', type: 'string', column: 'actor_type', description: 'user, service, system, api_key…', suggest: 'rollup' },
  { key: 'actor.name', type: 'string', column: 'actor_name', description: 'Actor display name', suggest: 'entities' },
  { key: 'actor.email', type: 'string', column: 'actor_email', description: 'Actor email', suggest: 'column' },
  { key: 'impersonator', type: 'string', column: 'impersonator_id', description: 'Who acted on behalf of the actor', suggest: 'column' },
  { key: 'tenant', type: 'string', column: 'tenant_id', description: 'Which customer/account it happened in', suggest: 'entities' },
  { key: 'tenant.name', type: 'string', column: 'tenant_name', description: 'Tenant display name', suggest: 'entities' },
  { key: 'executor', type: 'string', column: 'executor_id', description: 'What performed it (API, worker, cron…)', suggest: 'entities' },
  { key: 'executor.type', type: 'string', column: 'executor_type', description: 'api, worker, scheduler…', suggest: 'rollup' },
  { key: 'executor.name', type: 'string', column: 'executor_name', description: 'Executor display name', suggest: 'entities' },
  { key: 'job', type: 'string', column: 'job_id', description: 'Job id', suggest: 'none' },
  { key: 'attempt', type: 'number', column: 'job_attempt', description: 'Job attempt number', suggest: 'none' },
  { key: 'target', type: 'array', column: 'target_ids', description: 'What was changed (record id)', suggest: 'entities' },
  { key: 'target.type', type: 'array', column: 'target_types', description: 'Record type, e.g. booking', suggest: 'entities' },
  { key: 'target.name', type: 'array', column: 'target_names', description: 'Record display name', suggest: 'none' },
  { key: 'changes.field', type: 'array', column: 'changes_fields', description: 'Changed field names', suggest: 'none' },
  { key: 'operation', type: 'string', column: 'operation_id', description: 'Operation that grouped the work', suggest: 'none' },
  { key: 'parent', type: 'string', column: 'parent_event_id', description: 'Causing event id', suggest: 'none' },
  { key: 'request', type: 'string', column: 'request_id', description: 'Request id', suggest: 'none' },
  { key: 'trace', type: 'string', column: 'trace_id', description: 'Trace id', suggest: 'none' },
  { key: 'source', type: 'string', column: 'source', description: 'External system that supplied the change', suggest: 'column' },
  { key: 'id', type: 'string', column: 'event_id', description: 'Event id', suggest: 'none' },
  { key: 'ip', type: 'string', column: 'ip', description: 'Client IP', suggest: 'none' },
  { key: 'conformance', type: 'number', column: 'conformance', description: 'Envelope conformance 0–100', suggest: 'none' },
  { key: 'occurredAt', aliases: ['timestamp'], type: 'date', column: 'timestamp', description: 'When it happened (UTC)', suggest: 'none' },
  { key: 'receivedAt', type: 'date', column: 'received_at', description: 'When Trailmark received it (UTC)', suggest: 'none' },
  { key: 'description', type: 'text', column: 'description', description: 'Human-readable summary', suggest: 'none' },
];

/** Identifiers SQL mode may reference. `attributes` is Map(String, String): `attributes['metadata.plan'] = 'pro'`. */
export const SQL_ALLOWED_COLUMNS = [
  'event_id',
  'timestamp',
  'received_at',
  'environment',
  'action',
  'category',
  'outcome',
  'severity',
  'description',
  'actor_type',
  'actor_id',
  'actor_name',
  'actor_email',
  'impersonator_id',
  'impersonator_name',
  'executor_type',
  'executor_id',
  'executor_name',
  'job_id',
  'job_attempt',
  'tenant_id',
  'tenant_name',
  'source',
  'target_types',
  'target_ids',
  'target_names',
  'changes_fields',
  'changes_before',
  'changes_after',
  'operation_id',
  'parent_event_id',
  'request_id',
  'trace_id',
  'ip',
  'user_agent',
  'attributes',
  'conformance',
  'schema_version',
  'sdk',
] as const;

/**
 * Pure, deterministic-enough functions SQL mode may call (ClickHouse names as they appear in `EXPLAIN AST`, which
 * rewrites operators: `a = b` → equals, `x[1]` → arrayElement, `NOT x` → not, `x IN (…)` → in, lambdas → lambda).
 * Everything else is rejected — notably arrayJoin, dictGet*, table functions, subqueries, sleep*, throwIf,
 * getSetting, currentUser/hostName/version and any `system.*` access.
 */
export const SQL_ALLOWED_FUNCTIONS = [
  // logic & comparison
  'and',
  'or',
  'not',
  'xor',
  'equals',
  'notEquals',
  'less',
  'greater',
  'lessOrEquals',
  'greaterOrEquals',
  'in',
  'notIn',
  'like',
  'notLike',
  'ilike',
  'notILike',
  'isNull',
  'isNotNull',
  'if',
  'multiIf',
  'coalesce',
  'ifNull',
  'tuple',
  'array',
  // arithmetic
  'plus',
  'minus',
  'multiply',
  'divide',
  'intDiv',
  'modulo',
  'negate',
  'abs',
  'round',
  'floor',
  'ceil',
  'least',
  'greatest',
  // strings
  'length',
  'lengthUTF8',
  'empty',
  'notEmpty',
  'lower',
  'upper',
  'lowerUTF8',
  'upperUTF8',
  'trim',
  'trimBoth',
  'trimLeft',
  'trimRight',
  'concat',
  'substring',
  'substringUTF8',
  'startsWith',
  'endsWith',
  'position',
  'positionCaseInsensitive',
  'positionUTF8',
  'positionCaseInsensitiveUTF8',
  'match',
  'extract',
  'multiSearchAny',
  'multiMatchAny',
  'hasToken',
  'hasTokenCaseInsensitive',
  'splitByChar',
  'replaceAll',
  'replaceRegexpAll',
  'reverse',
  'domain',
  'cutQueryString',
  // arrays & maps
  'has',
  'hasAny',
  'hasAll',
  'indexOf',
  'countEqual',
  'arrayElement',
  'arrayExists',
  'arrayAll',
  'arrayCount',
  'arrayFilter',
  'arrayMap',
  'arrayStringConcat',
  'lambda',
  'mapContains',
  'mapKeys',
  'mapValues',
  // JSON over string values
  'JSONHas',
  'JSONExtractString',
  'JSONExtractInt',
  'JSONExtractFloat',
  'JSONExtractBool',
  'JSONLength',
  'JSONType',
  // conversion
  'toString',
  'toInt32',
  'toInt64',
  'toUInt32',
  'toUInt64',
  'toFloat64',
  'toInt64OrNull',
  'toFloat64OrNull',
  'toInt64OrZero',
  'toFloat64OrZero',
  'toDate',
  'toDateTime',
  'toDateTime64',
  'parseDateTimeBestEffort',
  'parseDateTimeBestEffortOrNull',
  'parseDateTime64BestEffortOrNull',
  'CAST',
  '_CAST',
  'toTypeName',
  // dates
  'now',
  'now64',
  'today',
  'yesterday',
  'toStartOfMinute',
  'toStartOfHour',
  'toStartOfDay',
  'toStartOfWeek',
  'toStartOfMonth',
  'toYYYYMM',
  'toYYYYMMDD',
  'toHour',
  'toMinute',
  'toDayOfWeek',
  'toDayOfMonth',
  'toMonth',
  'toYear',
  'dateDiff',
  'addDays',
  'addHours',
  'addMinutes',
  'subtractDays',
  'subtractHours',
  'subtractMinutes',
  'toIntervalSecond',
  'toIntervalMinute',
  'toIntervalHour',
  'toIntervalDay',
  'toIntervalWeek',
  'toIntervalMonth',
  'formatDateTime',
  // network
  'IPv4StringToNum',
  'isIPv4String',
  'isIPAddressInRange',
  'toIPv4',
  'toIPv6',
] as const;

/* ------------------------------------------------------------------ */
/* Value autocomplete (GET /api/projects/:projectId/suggest)           */
/* ------------------------------------------------------------------ */

export const suggestQuerySchema = z.object({
  /** A QUERY_FIELDS key/alias, or an attribute key (`attr.metadata.plan` / `metadata.plan`). */
  field: z.string().min(1).max(256),
  q: z.string().max(4096).optional(),
  lang: queryLangSchema.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** Case-insensitive match on value and label; empty = most frequent values. */
  prefix: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export const suggestResponseSchema = z.object({
  complete: z.boolean(),
  field: z.string(),
  values: z.array(z.object({ value: z.string(), label: z.string(), count: z.number().int() })),
});
export type SuggestResponse = z.infer<typeof suggestResponseSchema>;
