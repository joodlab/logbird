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
  changes: { field: string; before: string; after: string }[];
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
  tookMs: number;
}

export interface TrailQuery {
  target?: { type?: string; id: string };
  actor?: string;
  tenant?: string;
  q?: string;
  range?: { from: string; to: string };
  limit?: number;
  cursor?: string;
}
/** Blank means only whitespace, as JavaScript's `trim()` sees it (the .NET builder uses the same rule). */
const isBlank = (value: string) => value.trim().length === 0;
/** A lone UTF-16 surrogate becomes U+FFFD in the URL, so it could match a different identifier: refused (as in .NET). */
const hasLoneSurrogate = (value: string) => /[\uD800-\uDFFF]/u.test(value);
const fail = (message: string): never => {
  throw new TypeError(`trailQuery: ${message}`);
};
/** A present selector must name something: an absent value would silently widen the read (#263). */
function selectorValue(key: string, value: unknown): string {
  if (typeof value !== 'string' || isBlank(value))
    return fail(`\`${key}\` was given but is empty; pass a value or leave the key out (an empty ${key} would widen the read).`);
  if (hasLoneSurrogate(value)) return fail(`\`${key}\` contains an unpaired UTF-16 surrogate.`);
  return value;
}
/**
 * The extra query is wrapped in parentheses and ANDed with the selectors, so it must be one complete expression: its
 * parentheses (outside double-quoted values) stay balanced and never close more than they opened, and every quote is
 * closed. Otherwise `a) OR (b` would become `(a) OR (b) AND tenant:"…"`, an OR branch outside the tenant (#263).
 */
function assertSelfContained(q: string) {
  let depth = 0;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (c === '"') {
      for (i++; i < q.length && q[i] !== '"'; i++) if (q[i] === '\\') i++;
      if (i >= q.length) fail('`q` has an unterminated quoted value.');
    } else if (c === '(') depth++;
    else if (c === ')' && --depth < 0) fail('`q` closes a parenthesis it did not open; it must be one complete expression.');
  }
  if (depth !== 0) fail('`q` leaves a parenthesis open; it must be one complete expression.');
}
export interface TrailQueryOptions {
  /**
   * Only for a fetcher whose own server decides the scope (the Nuxt read route's `authorize` hook): a trail with no
   * selector and no query is then sent as is, for that server to complete or refuse. Present-but-empty selectors still
   * throw. Never use it with a project read key.
   */
  scopedByServer?: boolean;
}
/**
 * The search query for one record's, actor's or tenant's trail. Throws a TypeError instead of ever returning a query
 * wider than the caller asked for (#263): a trail needs a target, actor, tenant or non-blank query, and a selector key
 * that is present (own or inherited) must have a value (`tenant: session.tenantId` with no tenant id throws rather
 * than reading the whole project). Every input value is read once.
 */
export function trailQuery(input: TrailQuery, options: TrailQueryOptions = {}): Partial<SearchQuery> {
  if (!input || typeof input !== 'object') return fail('expects an options object.');
  let target: { type?: string; id: string } | undefined;
  if ('target' in input) {
    const given: unknown = input.target;
    if (!given || typeof given !== 'object') return fail('`target` was given but is empty; pass `{ id }` or `{ type, id }`, or leave the key out.');
    const id = selectorValue('target.id', (given as { id?: unknown }).id);
    if ('type' in given) {
      // An empty type is a real record type; an undefined one would drop the type and widen to every type with this id.
      const type: unknown = (given as { type?: unknown }).type;
      if (typeof type !== 'string') return fail('`target.type` was given but is not a string; pass the type or leave the key out.');
      if (hasLoneSurrogate(type)) return fail('`target.type` contains an unpaired UTF-16 surrogate.');
      target = { type, id };
    } else target = { id };
  }
  const actor = 'actor' in input ? selectorValue('actor', input.actor) : undefined;
  const tenant = 'tenant' in input ? selectorValue('tenant', input.tenant) : undefined;
  const rawQ: unknown = input.q;
  if (rawQ !== undefined && typeof rawQ !== 'string') return fail('`q` must be a string when given.');
  const q = rawQ !== undefined && !isBlank(rawQ) ? rawQ : undefined;
  if (q !== undefined) {
    if (hasLoneSurrogate(q)) fail('`q` contains an unpaired UTF-16 surrogate.');
    assertSelfContained(q);
  }
  const range = input.range;
  const limit = input.limit;
  const cursor = input.cursor;
  if (!target && actor === undefined && tenant === undefined && q === undefined) {
    if (options.scopedByServer) return { ...range, limit, cursor };
    fail('a trail needs a target, actor, tenant or query; an empty trail would be the whole project.');
  }
  const terms = [
    q === undefined ? '' : `(${q})`,
    target ? (target.type !== undefined ? formatRecordTerm(target.type, target.id) : `target:${quoteQueryValue(target.id)}`) : '',
    actor === undefined ? '' : `actor:${quoteQueryValue(actor)}`,
    tenant === undefined ? '' : `tenant:${quoteQueryValue(tenant)}`,
  ].filter(Boolean);
  return { ...range, q: terms.join(' AND '), limit, cursor };
}

export interface ReadOptions {
  endpoint: string;
  readKey: string;
  fetch?: typeof fetch;
}
export async function readAuditTrail(options: ReadOptions, query: Partial<SearchQuery>, signal?: AbortSignal): Promise<SearchResponse> {
  if (typeof window !== 'undefined') throw new Error('Logbird read keys are server-only');
  const url = new URL(`${options.endpoint.replace(/\/$/, '')}/v1/events`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
  const response = await (options.fetch ?? fetch)(url, {
    headers: { Authorization: `Bearer ${options.readKey}` },
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Logbird read HTTP ${response.status}`);
  return response.json() as Promise<SearchResponse>;
}
