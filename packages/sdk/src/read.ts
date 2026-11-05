/** Structural public read types, checked against contracts in read.test.ts; no runtime dependencies. */
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
export function trailQuery(input: TrailQuery): Partial<SearchQuery> {
  const quote = (value: string) => JSON.stringify(value);
  const terms = [
    input.q ? `(${input.q})` : '',
    input.target ? `target:${quote(input.target.id)}` : '',
    input.target?.type ? `target.type:${quote(input.target.type)}` : '',
    input.actor ? `actor:${quote(input.actor)}` : '',
    input.tenant ? `tenant:${quote(input.tenant)}` : '',
  ].filter(Boolean);
  return { ...input.range, q: terms.join(' AND '), limit: input.limit, cursor: input.cursor };
}
export interface ReadOptions {
  endpoint: string;
  readKey: string;
  fetch?: typeof fetch;
}
export async function readAuditTrail(options: ReadOptions, query: Partial<SearchQuery>, signal?: AbortSignal): Promise<SearchResponse> {
  if (typeof window !== 'undefined') throw new Error('Trailmark read keys are server-only');
  const url = new URL(`${options.endpoint.replace(/\/$/, '')}/v1/events`);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
  const response = await (options.fetch ?? fetch)(url, {
    headers: { Authorization: `Bearer ${options.readKey}` },
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Trailmark read HTTP ${response.status}`);
  return response.json() as Promise<SearchResponse>;
}
