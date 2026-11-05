/**
 * Field / column / function catalog for the query bar: the contract's QUERY_FIELDS plus the
 * console's presentation (order, `field:*` wording, examples) and SQL-mode signatures.
 */
import {
  QUERY_FIELDS as CONTRACT_FIELDS,
  type QueryFieldInfo,
  type QueryFieldType,
  SQL_ALLOWED_COLUMNS,
  SQL_ALLOWED_FUNCTIONS,
} from '@trailmark/contracts';

export interface QueryKeySpec extends QueryFieldInfo {
  example: string;
  /** What `field:*` (present, non-empty) means; offered as the first value suggestion. */
  presence?: string;
  /** Also offer the whole `field:*` term among key suggestions. */
  presenceShortcut?: boolean;
}

/** Console order (most useful first) and wording on top of the contract catalog. */
const PRESENTATION: Record<string, Pick<QueryKeySpec, 'example' | 'presence' | 'presenceShortcut'> & { description?: string }> = {
  action: { example: 'action:booking.*', description: 'What happened — exact, prefix* or /regex/' },
  outcome: { example: 'outcome:failure', description: 'success · failure · denied · partial · unknown' },
  severity: { example: 'severity:critical', description: 'info · notice · warning · critical' },
  actor: { example: 'actor:usr_42', presence: 'Any actor (events with an actor)', description: 'Who caused it (actor id)' },
  'actor.name': { example: 'actor.name:"Lina Haddad"' },
  'actor.email': { example: 'actor.email:lina@example.com', presence: 'Any email (actor has an email)' },
  'actor.type': { example: 'actor.type:user' },
  impersonator: {
    example: 'impersonator:usr_1',
    presence: 'Events done while impersonating',
    presenceShortcut: true,
    description: 'Support user acting as the actor',
  },
  tenant: { example: 'tenant:biz_7', presence: 'Any tenant (events with a tenant)', description: 'Customer account (tenant id)' },
  'tenant.name': { example: 'tenant.name:"Azure Hotels"' },
  executor: { example: 'executor:crm-worker', presence: 'Any executor (events with an executor)' },
  'executor.name': { example: 'executor.name:"CRM worker"' },
  'executor.type': { example: 'executor.type:worker' },
  job: { example: 'job:456', presence: 'Events run by a job' },
  attempt: { example: 'attempt:>2', description: 'Job attempt number — attempt:>2, attempt:[2 TO 5]' },
  target: { example: 'target:hotel_123', presence: 'Events that touched a record', description: 'Record the event touched (target id)' },
  'target.type': { example: 'target.type:booking' },
  'target.name': { example: 'target.name:"Suite 12"' },
  category: { example: 'category:booking' },
  env: { example: '-env:staging' },
  source: { example: 'source:channel-manager', presence: 'Changes supplied by an external system' },
  operation: { example: 'operation:op_101', presence: 'Events that belong to an operation' },
  parent: { example: 'parent:evt_123', presence: 'Events caused by another event' },
  request: { example: 'request:req_abc', presence: 'Events with a request id' },
  trace: { example: 'trace:4bf92f…', presence: 'Events with a trace id' },
  id: { example: 'id:01J…' },
  'changes.field': { example: 'changes.field:status' },
  conformance: { example: 'conformance:<50' },
  occurredAt: { example: 'occurredAt:>2026-11-01' },
  receivedAt: { example: 'receivedAt:[2026-11-01 TO 2026-11-03]' },
  ip: { example: 'ip:10.0.0.1' },
  description: { example: 'description:refund' },
};

const ORDER = Object.keys(PRESENTATION);

/** Every core query key, in suggestion order. */
export const QUERY_KEYS: QueryKeySpec[] = [...CONTRACT_FIELDS]
  .sort((a, b) => (ORDER.indexOf(a.key) + 1 || 999) - (ORDER.indexOf(b.key) + 1 || 999))
  .map((f) => {
    const p = PRESENTATION[f.key];
    return {
      ...f,
      example: p?.example ?? `${f.key}:…`,
      presence: p?.presence,
      presenceShortcut: p?.presenceShortcut,
      description: p?.description ?? f.description,
    };
  });

const BY_NAME = new Map<string, QueryKeySpec>();
for (const f of QUERY_KEYS) {
  BY_NAME.set(f.key, f);
  for (const a of f.aliases ?? []) BY_NAME.set(a, f);
}

/** Core field for a key or alias (`environment` → env). Attribute keys return undefined. */
export function coreField(key: string): QueryKeySpec | undefined {
  return BY_NAME.get(key);
}

/** Strip `attr.` / `attributes.` from an attribute key. */
export function attributeKey(key: string): string {
  return key.replace(/^(attr|attributes)\./, '');
}

/**
 * How to write an attribute key in the query language. Bare keys are attribute lookups unless they
 * collide with a core field (`actor.name` the attribute must stay `attr.actor.name`).
 */
export function attributeQueryKey(attr: string): string {
  return coreField(attr) || attr === '' ? `attr.${attr}` : attr;
}

export const TYPE_BADGE: Record<QueryFieldType | 'map' | 'fn' | 'kw' | 'attr', string> = {
  string: 'str',
  number: 'num',
  date: 'date',
  array: 'arr',
  text: 'text',
  map: 'map',
  fn: 'fn',
  kw: 'kw',
  attr: 'attr',
};

/* ------------------------------------------------------------------ */
/* SQL mode                                                            */
/* ------------------------------------------------------------------ */

export interface SqlColumnSpec {
  name: string;
  type: QueryFieldType | 'map';
  description: string;
  /** Query-language key that serves value suggestions for this column. */
  suggestField?: string;
}

const SQL_EXTRA: Record<string, Omit<SqlColumnSpec, 'name'>> = {
  impersonator_name: { type: 'string', description: 'Impersonator display name' },
  changes_before: { type: 'array', description: 'Values before the change (per changed field)' },
  changes_after: { type: 'array', description: 'Values after the change (per changed field)' },
  user_agent: { type: 'string', description: 'Client user agent' },
  attributes: { type: 'map', description: "Map(String, String) — attributes['metadata.plan']" },
  schema_version: { type: 'string', description: 'Envelope schema version' },
  sdk: { type: 'string', description: 'SDK that sent the event' },
};

/** Suggestion order: the columns people filter on most first. */
const SQL_ORDER = [
  'action',
  'outcome',
  'severity',
  'actor_id',
  'actor_name',
  'tenant_id',
  'tenant_name',
  'attributes',
  'job_attempt',
  'executor_name',
  'target_types',
  'target_ids',
];

export const SQL_COLUMNS: SqlColumnSpec[] = [...SQL_ALLOWED_COLUMNS]
  .sort((a, b) => (SQL_ORDER.indexOf(a) + 1 || 999) - (SQL_ORDER.indexOf(b) + 1 || 999))
  .map((name) => {
    const f = CONTRACT_FIELDS.find((x) => x.column === name);
    if (f) return { name, type: f.type, description: f.description, suggestField: f.suggest === 'none' ? undefined : f.key };
    return { name, ...(SQL_EXTRA[name] ?? { type: 'string' as const, description: '' }) };
  });

const SQL_COLUMN_SET = new Set<string>(SQL_ALLOWED_COLUMNS);
export const isSqlColumn = (name: string) => SQL_COLUMN_SET.has(name);
export const sqlColumn = (name: string) => SQL_COLUMNS.find((c) => c.name === name);

const FUNCTION_SET = new Set<string>(SQL_ALLOWED_FUNCTIONS);
const FUNCTION_LOWER = new Set<string>(SQL_ALLOWED_FUNCTIONS.map((f) => f.toLowerCase()));
/** Allowed exactly, or modulo case (ClickHouse treats many function names case-insensitively). */
export function isAllowedFunction(name: string): boolean {
  return FUNCTION_SET.has(name) || FUNCTION_LOWER.has(name.toLowerCase());
}

/** AST names that people write as operators (`=`, `IN`, `x[1]`, `->`…), so never suggested as functions. */
const OPERATOR_FUNCTIONS = new Set([
  'and',
  'or',
  'not',
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
  'tuple',
  'array',
  'arrayElement',
  'lambda',
  'negate',
  'plus',
  'minus',
  'multiply',
  'divide',
  '_CAST',
]);

const SIGNATURES: Record<string, string> = {
  has: 'has(array, value)',
  hasAny: 'hasAny(array, [values])',
  hasAll: 'hasAll(array, [values])',
  startsWith: 'startsWith(s, prefix)',
  endsWith: 'endsWith(s, suffix)',
  match: "match(s, 're2')",
  extract: "extract(s, 're2')",
  lower: 'lower(s)',
  upper: 'upper(s)',
  length: 'length(s | array)',
  empty: 'empty(s | array)',
  notEmpty: 'notEmpty(s | array)',
  position: 'position(haystack, needle)',
  positionCaseInsensitive: 'positionCaseInsensitive(haystack, needle)',
  hasToken: 'hasToken(s, token)',
  hasTokenCaseInsensitive: 'hasTokenCaseInsensitive(s, token)',
  multiSearchAny: 'multiSearchAny(s, [needles])',
  arrayExists: 'arrayExists(x -> cond, array)',
  arrayAll: 'arrayAll(x -> cond, array)',
  arrayCount: 'arrayCount(x -> cond, array)',
  arrayFilter: 'arrayFilter(x -> cond, array)',
  arrayMap: 'arrayMap(x -> expr, array)',
  mapContains: "mapContains(attributes, 'key')",
  mapKeys: 'mapKeys(attributes)',
  mapValues: 'mapValues(attributes)',
  JSONHas: "JSONHas(json, 'key')",
  JSONExtractString: "JSONExtractString(json, 'key')",
  JSONExtractInt: "JSONExtractInt(json, 'key')",
  toFloat64OrNull: "toFloat64OrNull(attributes['key'])",
  toInt64OrNull: 'toInt64OrNull(s)',
  toHour: 'toHour(timestamp)',
  toDayOfWeek: 'toDayOfWeek(timestamp) — 1 = Monday',
  toStartOfDay: 'toStartOfDay(timestamp)',
  toStartOfHour: 'toStartOfHour(timestamp)',
  toDate: 'toDate(timestamp)',
  now: 'now()',
  today: 'today()',
  dateDiff: "dateDiff('unit', start, end)",
  subtractDays: 'subtractDays(t, n)',
  subtractHours: 'subtractHours(t, n)',
  addDays: 'addDays(t, n)',
  if: 'if(cond, then, else)',
  multiIf: 'multiIf(cond1, then1, …, else)',
  coalesce: 'coalesce(a, b, …)',
  isNull: 'isNull(x)',
  isNotNull: 'isNotNull(x)',
  isIPAddressInRange: "isIPAddressInRange(ip, '10.0.0.0/8')",
  replaceRegexpAll: "replaceRegexpAll(s, 're2', replacement)",
  concat: 'concat(a, b, …)',
  substring: 'substring(s, offset, length)',
  splitByChar: "splitByChar(',', s)",
  indexOf: 'indexOf(array, x)',
  countEqual: 'countEqual(array, x)',
  parseDateTimeBestEffort: 'parseDateTimeBestEffort(s)',
  formatDateTime: "formatDateTime(t, '%F')",
  round: 'round(x, digits)',
  least: 'least(a, b)',
  greatest: 'greatest(a, b)',
  toString: 'toString(x)',
};

export interface SqlFunctionSpec {
  name: string;
  signature: string;
}

/** Callable allowed functions, signature-bearing ones (the common ones) first. */
export const SQL_FUNCTIONS: SqlFunctionSpec[] = SQL_ALLOWED_FUNCTIONS.filter((f) => !OPERATOR_FUNCTIONS.has(f))
  .map((name) => ({ name, signature: SIGNATURES[name] ?? `${name}(…)` }))
  .sort((a, b) => Number(Boolean(SIGNATURES[b.name])) - Number(Boolean(SIGNATURES[a.name])));

/** Signature for a function, e.g. `has(array, value)` (falls back to `name(…)`). */
export const sqlSignature = (name: string): string => SIGNATURES[name] ?? `${name}(…)`;

export const SQL_KEYWORDS = ['AND', 'OR', 'NOT', 'IN', 'NOT IN', 'LIKE', 'ILIKE', 'IS NULL', 'IS NOT NULL', 'BETWEEN', 'INTERVAL'];
