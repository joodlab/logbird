import { parseQueryExpression } from '@logbird/contracts/query-syntax';
import { formatRecordTerm, quoteQueryValue } from '@logbird/contracts/record-selector';

/** Structural public read types, checked against contracts in read.test.ts. */
export interface SearchQuery {
  from?: string;
  to?: string;
  q?: string;
  lang?: 'query' | 'sql';
  cursor?: string;
  limit: number;
  order: 'asc' | 'desc';
}
/** The JSON kind sent for a change value, with `absent` for an omitted side. */
export type ChangeValueKind = 'absent' | 'null' | 'string' | 'number' | 'boolean' | 'json';

export interface AuditEvent {
  id: string;
  projectId: string;
  timestamp: string;
  receivedAt: string;
  environment: string;
  action: string;
  category: string;
  outcome: string;
  severity: string;
  description: string;
  actor: { type: string; id: string; name: string; email: string } | null;
  impersonator: { id: string; name: string } | null;
  executor: { type: string; id: string; name: string; jobId: string; attempt: number } | null;
  tenant: { id: string; name: string } | null;
  source: string | null;
  targets: { type: string; id: string; name: string }[];
  changes: {
    field: string;
    before: string;
    after: string;
    /** Omitted when the original kind is unknown. */
    beforeKind?: ChangeValueKind;
    /** Omitted when the original kind is unknown. */
    afterKind?: ChangeValueKind;
  }[];
  context: { operationId: string; parentEventId: string; requestId: string; traceId: string; ip: string; userAgent: string };
  attributes: Record<string, string>;
  conformance: number;
  schemaVersion: string;
  sdk: string;
}
export interface SearchResponse {
  data: AuditEvent[];
  nextCursor: string | null;
  total: number;
  /** False when `total` is a lower bound (capped at 10,001, or the count did not finish). */
  totalExact?: boolean;
  /**
   * The time window the server applied: `from` inclusive, `to` exclusive, on `timestamp` (ISO 8601 UTC). Without
   * `from` the server reads at most the 24 hours before `to`, so a short history may just be a short window. Absent
   * from servers older than this field.
   */
  range?: { from: string; to: string };
  tookMs: number;
}

/** One event with its causation context, from `GET /v1/events/{id}`. */
export interface EventDetail {
  event: AuditEvent;
  /** The original document as stored; null under any field mask. */
  payload: unknown;
  /** The nearest ancestors through `context.parentEventId`, furthest first (at most 100). */
  parents: AuditEvent[];
  /** How many events (in the reader's scope) name this one as their parent. */
  childCount: number;
  /** How many events (in the reader's scope) share its `context.operationId`, itself included. */
  operationSize: number;
}

/** A range bound: an ISO 8601 string, a `Date`, or epoch milliseconds. Anything else is refused. */
export type RangeBound = string | Date | number;
/**
 * Pass as a trail's `range` to read the server's default window on purpose: the 24 hours before now. A trail always
 * names its window, because a read without one returns a short history that looks complete.
 */
export const SERVER_DEFAULT_RANGE = 'server-default';
export type ServerDefaultRange = typeof SERVER_DEFAULT_RANGE;
export interface TrailQuery {
  target?: { type?: string; id: string };
  actor?: string;
  tenant?: string;
  q?: string;
  /**
   * Required: the window, with at least `from` (`to` defaults to now), or `SERVER_DEFAULT_RANGE` for the server's
   * default (the 24 hours before now). `from` is inclusive and `to` exclusive, on the event's timestamp.
   */
  range?: { from?: RangeBound; to?: RangeBound } | ServerDefaultRange;
  /** `desc` (default) newest first, `asc` oldest first. Events in the same millisecond are ordered by id, not by cause. */
  order?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
}
/** A trail after the input boundary: plain, deeply frozen, holding only strings and numbers. */
export type TrailSnapshot = Readonly<{
  target?: Readonly<{ type?: string; id: string }>;
  actor?: string;
  tenant?: string;
  /** Absent when the caller's `q` was absent or blank. */
  q?: string;
  range?: Readonly<{ from?: string; to?: string }> | ServerDefaultRange;
  order?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
}>;
/** What `readAuditTrail` accepts: a search query whose range bounds may also be `Date`s or epoch milliseconds. */
export type SearchInput = Omit<Partial<SearchQuery>, 'from' | 'to'> & { from?: RangeBound; to?: RangeBound };
/** A search query after the input boundary: plain, frozen, holding only strings and numbers. */
export type SearchSnapshot = Readonly<Partial<SearchQuery>>;

/** What the read helpers throw for input they will not use: a TypeError with a stable `code`. */
export class TrailQueryError extends TypeError {
  readonly code = 'trail_query_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'TrailQueryError';
  }
}
/** True for a TrailQueryError, also one thrown by another copy of this module (checked by its code). */
export function isTrailQueryError(error: unknown): error is TrailQueryError {
  try {
    return error instanceof TrailQueryError || (error instanceof TypeError && (error as { code?: unknown }).code === 'trail_query_invalid');
  } catch {
    return false;
  }
}

// The input boundary (#263). Every public read entry point first copies its input into a plain frozen snapshot of
// primitives, reading each property exactly once; nothing after that point touches the caller's object. A value that
// is not the primitive type its field expects is refused here, never interpreted: no getter, prototype, toJSON,
// toString or Proxy trap of the caller's object runs after the check, so what is checked is what is sent.

const fail = (where: string, message: string): never => {
  throw new TrailQueryError(`${where}: ${message}`);
};
const isObject = (value: unknown): value is object => value !== null && typeof value === 'object';
/**
 * A container the boundary reads fields from: a plain object, a null-prototype object or an ordinary class instance
 * (Vue reactive ones too, whatever their `Symbol.toStringTag`). A container that keeps its entries behind methods or
 * an iterator is refused, judged by what it does rather than where it comes from: anything iterable (an array, Map,
 * Set, URLSearchParams, Headers, FormData) or with a `get` method (any Map-like store, such as a MobX ObservableMap or
 * Node's MIMEParams), any Date-like, and the named platform containers. Reading named fields from one of those would
 * silently drop every bound, selector or `q` (`new URLSearchParams('q=…')` would become a project-wide read).
 */
function isRecord(value: unknown): value is object {
  if (!isObject(value) || Array.isArray(value) || ArrayBuffer.isView(value)) return false;
  for (const key of CONTAINER_METHODS) if (hasMethod(value, key)) return false;
  for (const name of PLATFORM_CONTAINERS) {
    const type = (globalThis as Record<string, unknown>)[name];
    if (typeof type === 'function' && value instanceof type) return false;
  }
  return true;
}
/**
 * Methods that mark a container keeping its entries elsewhere than named properties: sync and async iterators (arrays,
 * Maps, Sets, URLSearchParams, Headers, FormData, streams), `get` (any Map-like store), `getTime` (Date-likes),
 * `getReader` (streams) and `then` (a promise or thenable, from any realm, that was never awaited).
 */
const CONTAINER_METHODS: (string | symbol)[] = [Symbol.iterator, Symbol.asyncIterator, 'get', 'getTime', 'getReader', 'then'];
/** Built-ins with none of those methods that still hold no named fields. */
const PLATFORM_CONTAINERS = [
  'Date',
  'RegExp',
  'Promise',
  'Error',
  'WeakMap',
  'WeakSet',
  'URL',
  'Request',
  'Response',
  'Blob',
  'EventTarget',
  'ReadableStream',
];
/**
 * Whether the object or its prototype chain defines `key` as a function-valued data property. Read through property
 * descriptors, so no accessor of the caller's object runs here (an accessor named `get` is not a method).
 */
function hasMethod(value: object, key: string | symbol): boolean {
  for (let object: object | null = value; object !== null; object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    // An iterator protocol served by an accessor still marks a container (the accessor is not run); any other accessor
    // (say, a record field named `get`) is not a method.
    if (descriptor && !('value' in descriptor)) return typeof key === 'symbol';
    if (descriptor) return typeof descriptor.value === 'function';
  }
  return false;
}
/** Blank means only whitespace, as JavaScript's `trim()` sees it (the .NET builder uses the same rule). */
const isBlank = (value: string) => value.trim().length === 0;
/**
 * Reads a key once. It is present when its value is defined (a Proxy may serve a value its `has` trap denies) or the
 * key is `in` the object, so a present `undefined` still counts and Vue tracks a key added to reactive options later.
 */
function readOnce(object: object, key: string): { present: boolean; value: unknown } {
  const value = (object as Record<string, unknown>)[key];
  return { present: value !== undefined || key in object, value };
}
/** Every string the boundary accepts is well-formed UTF-16: a lone surrogate becomes U+FFFD in a URL (as in .NET). */
function text(where: string, field: string, value: unknown): string {
  if (typeof value !== 'string') return fail(where, `\`${field}\` must be a string.`);
  if (/[\uD800-\uDFFF]/u.test(value)) return fail(where, `\`${field}\` contains an unpaired UTF-16 surrogate.`);
  return value;
}
const optionalText = (where: string, field: string, value: unknown) => (value === undefined ? undefined : text(where, field, value));
/** A present selector must name something: an absent or blank value would silently widen the read. */
function selector(where: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || isBlank(value))
    return fail(where, `\`${field}\` was given but is empty; pass a value or leave the key out (an empty ${field} would widen the read).`);
  return text(where, field, value);
}
const BOUND_TYPES = 'must be a Date, epoch milliseconds or an ISO 8601 string.';
/**
 * A range bound becomes an ISO 8601 string. A `Date` is read through its internal time value (never its own toJSON or
 * toISOString); a number is whole epoch milliseconds (a fraction would round the bound and widen it); a string is
 * passed as is for the server to validate.
 */
function rangeBound(where: string, field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    // The server keeps milliseconds: a finer fraction would be truncated, moving a lower bound earlier.
    if (/:\d{2}\.\d{4,}/.test(value)) return fail(where, `\`${field}\` has more than millisecond precision.`);
    return text(where, field, value);
  }
  let time = Number.NaN;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return fail(where, `\`${field}\` must be whole epoch milliseconds.`);
    time = value;
  } else if (isObject(value)) {
    try {
      time = Date.prototype.getTime.call(value);
    } catch {
      return fail(where, `\`${field}\` ${BOUND_TYPES}`);
    }
  } else return fail(where, `\`${field}\` ${BOUND_TYPES}`);
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return fail(where, `\`${field}\` is not a valid time.`);
  return date.toISOString();
}
/** An integer, or its decimal digits (how a page size arrives in a URL query). */
function optionalLimit(where: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,6}$/.test(value)) return Number(value);
  return fail(where, '`limit` must be an integer.');
}
function optionalChoice<T extends string>(where: string, field: string, value: unknown, choices: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (choices as readonly string[]).includes(value)) return value as T;
  return fail(where, `\`${field}\` must be one of ${choices.map((choice) => `'${choice}'`).join(', ')}.`);
}
/** Keeps only the defined fields, so the snapshot's own keys are exactly the ones it holds. */
function frozen<T extends object>(fields: T): Readonly<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return Object.freeze(out) as Readonly<T>;
}

/** The trail input boundary: the caller's trail as a plain frozen snapshot of primitives, each property read once. */
export function snapshotTrail(input: TrailQuery, where = 'trailQuery'): TrailSnapshot {
  if (!isRecord(input)) return fail(where, 'expects an options object.');
  let target: TrailSnapshot['target'];
  const givenTarget = readOnce(input, 'target');
  if (givenTarget.present) {
    const given = givenTarget.value;
    if (!isRecord(given)) return fail(where, '`target` was given but is empty; pass `{ id }` or `{ type, id }`, or leave the key out.');
    const id = selector(where, 'target.id', (given as { id?: unknown }).id);
    const givenType = readOnce(given, 'type');
    // An empty type is a real record type; an undefined one would drop the type and widen to every type with this id.
    if (givenType.present && typeof givenType.value !== 'string')
      return fail(where, '`target.type` was given but is not a string; pass the type or leave the key out.');
    target = Object.freeze(givenType.present ? { type: text(where, 'target.type', givenType.value), id } : { id });
  }
  const givenActor = readOnce(input, 'actor');
  const actor = givenActor.present ? selector(where, 'actor', givenActor.value) : undefined;
  const givenTenant = readOnce(input, 'tenant');
  const tenant = givenTenant.present ? selector(where, 'tenant', givenTenant.value) : undefined;
  const q = optionalText(where, 'q', (input as { q?: unknown }).q);
  const givenRange: unknown = (input as { range?: unknown }).range;
  let range: TrailSnapshot['range'];
  if (givenRange === SERVER_DEFAULT_RANGE) range = SERVER_DEFAULT_RANGE;
  else if (givenRange !== undefined) {
    if (!isRecord(givenRange)) return fail(where, '`range` must be an object with `from` and/or `to`.');
    const from = rangeBound(where, 'range.from', (givenRange as { from?: unknown }).from);
    const to = rangeBound(where, 'range.to', (givenRange as { to?: unknown }).to);
    // A range with neither bound (say `{ start, end }`) would fall back to the server's default window.
    if (from === undefined && to === undefined) return fail(where, '`range` was given without `from` or `to`; pass a bound or leave the key out.');
    range = frozen({ from, to });
  }
  const order = optionalChoice(where, 'order', (input as { order?: unknown }).order, ['asc', 'desc'] as const);
  const limit = optionalLimit(where, (input as { limit?: unknown }).limit);
  const cursor = optionalText(where, 'cursor', (input as { cursor?: unknown }).cursor);
  return frozen({
    target,
    actor,
    tenant,
    q: q === undefined || isBlank(q) ? undefined : q,
    range,
    order,
    limit,
    cursor: cursor || undefined,
  });
}
/** The fields of a search query in canonical order. */
const SEARCH_FIELDS = ['q', 'lang', 'from', 'to', 'limit', 'cursor', 'order'] as const;
/** The search query boundary: a plain frozen snapshot of the known search fields, each read once; others are dropped. */
export function snapshotSearchQuery(query: SearchInput, where = 'readAuditTrail'): SearchSnapshot {
  if (!isRecord(query)) return fail(where, 'expects a query object.');
  const input = query as Record<string, unknown>;
  // One read per key, in the canonical order.
  const q = optionalText(where, 'q', input.q);
  const lang = optionalChoice(where, 'lang', input.lang, ['query', 'sql'] as const);
  const from = rangeBound(where, 'from', input.from);
  const to = rangeBound(where, 'to', input.to);
  const limit = optionalLimit(where, input.limit);
  const cursor = optionalText(where, 'cursor', input.cursor);
  const order = optionalChoice(where, 'order', input.order, ['asc', 'desc'] as const);
  return frozen({ q, lang, from, to, limit, cursor: cursor || undefined, order });
}
/**
 * The canonical serialisation of a search snapshot without its cursor: two snapshots share a key exactly when they ask
 * for the same events. It is a fixed-order array of strings, numbers and nulls, so two different trails cannot collide.
 */
export function searchKey(snapshot: SearchSnapshot): string {
  return JSON.stringify(SEARCH_FIELDS.filter((field) => field !== 'cursor').map((field) => snapshot[field] ?? null));
}

/**
 * The extra query is wrapped in parentheses and ANDed with the selectors, so it must be one complete expression on its
 * own, checked with the same query parser the server and console use. Otherwise `a) OR (b` would become
 * `(a) OR (b) AND tenant:"…"`, an OR branch outside the tenant (#263).
 */
function assertSelfContained(q: string) {
  try {
    parseQueryExpression(q);
  } catch (cause) {
    fail('trailQuery', `\`q\` is not a complete Logbird query on its own (${cause instanceof Error ? cause.message : 'parse error'}).`);
  }
}
/**
 * The search query for one record's, actor's or tenant's trail. Throws a TrailQueryError (a TypeError) instead of
 * ever returning a query wider than the caller asked for (#263): a trail needs a target, actor, tenant or non-blank
 * query, and a selector key that is present (own or inherited) must have a value (`tenant: session.tenantId` with no
 * tenant id throws rather than reading the whole project). The input passes the boundary first (`snapshotTrail`).
 *
 * Accepted input: an object (plain, null-prototype, a class instance or a Vue reactive object) whose fields are named
 * properties holding strings, numbers or `Date`s as typed by `TrailQuery`; containers that keep entries elsewhere
 * (iterables, Map-like stores, streams, promises) are not trail inputs.
 */
export function trailQuery(input: TrailQuery): Partial<SearchQuery> {
  const trail = snapshotTrail(input);
  const { target, actor, tenant, q } = trail;
  if (q !== undefined) assertSelfContained(q);
  if (!target && actor === undefined && tenant === undefined && q === undefined)
    fail('trailQuery', 'a trail needs a target, actor, tenant or query; an empty trail would be the whole project.');
  const terms = [
    q === undefined ? '' : `(${q})`,
    target ? (target.type !== undefined ? formatRecordTerm(target.type, target.id) : `target:${quoteQueryValue(target.id)}`) : '',
    actor === undefined ? '' : `actor:${quoteQueryValue(actor)}`,
    tenant === undefined ? '' : `tenant:${quoteQueryValue(tenant)}`,
  ].filter(Boolean);
  const window = trailWindow(trail);
  return { ...window, q: terms.join(' AND '), order: trail.order, limit: trail.limit, cursor: trail.cursor };
}
const NO_WINDOW =
  "without `from` the server reads only the 24 hours before `to`, so the trail would look complete when it is not. Pass `range: { from }` (`to` defaults to now), or `range: SERVER_DEFAULT_RANGE` to read the server's default window on purpose.";
/**
 * The window a trail reads, as search fields. A trail always names one: without `from` the server reads only the 24
 * hours before `to`, and a short history would look complete. `SERVER_DEFAULT_RANGE` asks for that default on purpose
 * (no bounds are sent). Throws a TrailQueryError otherwise.
 */
export function trailWindow(trail: Pick<TrailSnapshot, 'range'>, where = 'trailQuery'): { from?: string; to?: string } {
  const range = trail.range;
  if (range === SERVER_DEFAULT_RANGE) return {};
  if (range === undefined) return fail(where, `a trail needs a \`range\`: ${NO_WINDOW}`);
  if (range.from === undefined) return fail(where, `\`range\` has no \`from\`: ${NO_WINDOW}`);
  return range;
}

export interface ReadOptions {
  endpoint: string;
  readKey: string;
  fetch?: typeof fetch;
}
/**
 * One page of events for an explicit search query. The query passes the boundary first (`snapshotSearchQuery`): only
 * its known fields are sent, each read once. It always needs a non-blank `q`: build it with `trailQuery`, or pass
 * `q: 'timestamp:*'` to read a whole project on purpose.
 */
export async function readAuditTrail(options: ReadOptions, query: SearchInput, signal?: AbortSignal): Promise<SearchResponse> {
  if (typeof window !== 'undefined') throw new Error('Logbird read keys are server-only');
  const snapshot = snapshotSearchQuery(query);
  const url = new URL(`${options.endpoint.replace(/\/$/, '')}/v1/events`);
  for (const field of SEARCH_FIELDS) {
    const value = snapshot[field];
    if (value !== undefined) url.searchParams.set(field, String(value));
  }
  // The last check, on what is about to be sent rather than on what came in (#263): whatever the caller's object was,
  // a request without a non-blank `q` would read the whole project, so it never leaves.
  if (!url.searchParams.get('q')?.trim())
    fail(
      'readAuditTrail',
      "the query has no `q`, so it would read the whole project; build it with trailQuery, or pass `q: 'timestamp:*'` to read the whole project on purpose.",
    );
  const response = await (options.fetch ?? fetch)(url, {
    headers: { Authorization: `Bearer ${options.readKey}` },
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Logbird read HTTP ${response.status}`);
  return response.json() as Promise<SearchResponse>;
}

/**
 * One event by id, with its causation context: the nearest ancestors (`parents`, furthest first), how many events name
 * it as their parent (`childCount`; list them with `parent:` in a trail's `q`), how many share its operation, and the
 * original document (`payload`, null under a field mask). No time window applies. Resolves to null when the id is
 * unknown or outside the key's scope (404).
 */
export async function readAuditEvent(options: ReadOptions, id: string, signal?: AbortSignal): Promise<EventDetail | null> {
  if (typeof window !== 'undefined') throw new Error('Logbird read keys are server-only');
  const eventId = selector('readAuditEvent', 'id', id);
  const url = new URL(`${options.endpoint.replace(/\/$/, '')}/v1/events/${encodeURIComponent(eventId)}`);
  const response = await (options.fetch ?? fetch)(url, {
    headers: { Authorization: `Bearer ${options.readKey}` },
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Logbird read HTTP ${response.status}`);
  return response.json() as Promise<EventDetail>;
}

/**
 * Every event of a trail, page after page, as one async iterator: `for await (const event of iterateAuditTrail(…))`.
 * The trail needs an explicit `range` with `from` (`SERVER_DEFAULT_RANGE` is refused here: a whole trail has to say
 * where it starts). Pages follow `nextCursor` within the window the first page applied (its `range`), so later pages
 * never drift with the clock, and the iterator ends after the last page. Breaking out of the loop stops it before the
 * next request; `signal` aborts a request in flight.
 *
 * A pass is not a snapshot: an event stored while you iterate, with a timestamp behind your position, is not
 * returned, and nor is one older than `from`. To pick up late arrivals, read again later with `receivedAt:>=` a time
 * well before the last `receivedAt` you saw (receipt times are not a strict sequence) and skip ids you already have.
 */
export async function* iterateAuditTrail(options: ReadOptions, trail: TrailQuery, signal?: AbortSignal): AsyncGenerator<AuditEvent, void, undefined> {
  const snapshot = snapshotTrail(trail, 'iterateAuditTrail');
  if (snapshot.range === SERVER_DEFAULT_RANGE)
    fail('iterateAuditTrail', 'a whole trail needs `range: { from }`; `SERVER_DEFAULT_RANGE` reads only the last 24 hours.');
  let query: Partial<SearchQuery> = trailQuery({ ...snapshot, limit: snapshot.limit ?? 200 });
  for (;;) {
    const page = await readAuditTrail(options, query, signal);
    for (const event of page.data) yield event;
    const next = page.nextCursor;
    if (!next) return;
    // A server that hands back the cursor it was given would loop forever.
    if (next === query.cursor) throw new Error('Logbird read: the server repeated a page cursor.');
    // Keep the window the first page applied: a cursor carries none, and an open `to` would move with the clock.
    query = { ...query, ...(page.range ? { from: page.range.from, to: page.range.to } : {}), cursor: next };
  }
}
