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
/** A present selector must name something: an absent value would silently widen the read (#263). */
function selector(input: TrailQuery, key: 'actor' | 'tenant'): string | undefined {
  if (!Object.hasOwn(input, key)) return undefined;
  const value = input[key];
  if (typeof value !== 'string' || isBlank(value))
    throw new TypeError(`trailQuery: \`${key}\` was given but is empty; pass a value or leave the key out (an empty ${key} would widen the read).`);
  return value;
}
/**
 * The search query for one record's, actor's or tenant's trail. Throws a TypeError instead of ever returning a query
 * wider than the caller asked for (#263): a trail needs a target, actor, tenant or non-blank query, and a selector key
 * that is present must have a value (`tenant: session.tenantId` with no tenant id throws rather than reading the
 * whole project).
 */
export function trailQuery(input: TrailQuery): Partial<SearchQuery> {
  let target: { type?: string; id: string } | undefined;
  if (Object.hasOwn(input, 'target')) {
    const given = input.target as unknown;
    if (!given || typeof given !== 'object')
      throw new TypeError('trailQuery: `target` was given but is empty; pass `{ id }` or `{ type, id }`, or leave the key out.');
    const { id, type } = given as { id?: unknown; type?: unknown };
    if (typeof id !== 'string' || isBlank(id)) throw new TypeError('trailQuery: `target` needs an id; a target without one would widen the read.');
    if (type !== undefined && typeof type !== 'string') throw new TypeError('trailQuery: `target.type` must be a string when given.');
    target = { type, id };
  }
  const actor = selector(input, 'actor');
  const tenant = selector(input, 'tenant');
  if (input.q !== undefined && typeof input.q !== 'string') throw new TypeError('trailQuery: `q` must be a string when given.');
  const q = input.q !== undefined && !isBlank(input.q) ? input.q : undefined;
  if (!target && actor === undefined && tenant === undefined && q === undefined)
    throw new TypeError('trailQuery: a trail needs a target, actor, tenant or query; an empty trail would be the whole project.');
  const terms = [
    q === undefined ? '' : `(${q})`,
    target ? (target.type !== undefined ? formatRecordTerm(target.type, target.id) : `target:${quoteQueryValue(target.id)}`) : '',
    actor === undefined ? '' : `actor:${quoteQueryValue(actor)}`,
    tenant === undefined ? '' : `tenant:${quoteQueryValue(tenant)}`,
  ].filter(Boolean);
  return { ...input.range, q: terms.join(' AND '), limit: input.limit, cursor: input.cursor };
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
