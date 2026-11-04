import {
  type ApiKey,
  apiKeySchema,
  createApiKeyResponseSchema,
  createProjectResponseSchema,
  type EntityKind,
  entityListResponseSchema,
  entityProfileSchema,
  eventDetailSchema,
  eventSchema,
  facetResponseSchema,
  fieldsResponseSchema,
  histogramResponseSchema,
  ingestResponseSchema,
  meResponseSchema,
  overviewResponseSchema,
  type Project,
  projectSchema,
  retentionStatusSchema,
  routes,
  type SavedView,
  savedViewSchema,
  searchResponseSchema,
} from '@trailmark/contracts';
import { z } from 'zod';
import { toApiError } from './errors';
import { getTransport } from './transport';

type Query = Record<string, string | number | boolean | null | undefined>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

/** Fill `:params` in a contract route path. */
export function pathFor(template: string, params: Record<string, string> = {}): string {
  return template.replace(/:(\w+)/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`Missing route param "${key}" for ${template}`);
    return encodeURIComponent(value);
  });
}

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request<S extends z.ZodType>(schema: S, method: string, path: string, options: RequestOptions = {}): Promise<z.output<S>> {
  const fetchImpl = await getTransport();
  const response = await fetchImpl(withQuery(path, options.query), {
    method,
    signal: options.signal,
    headers: options.body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return schema.parse({ ok: true });
  const json: unknown = await response.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error(`[api] ${method} ${path} returned an unexpected shape`, parsed.error.issues);
    throw parsed.error;
  }
  return parsed.data;
}

/** Lists are `{ data: [...] }` (contracts/console.ts); bare arrays are accepted for robustness. */
function listOf<T extends z.ZodType>(item: T) {
  return z.union([z.object({ data: z.array(item) }).transform((v) => v.data), z.array(item)]);
}

/** Single resources may come bare or wrapped (`{ project }`, `{ key }`). */
function oneOf<T extends z.ZodType>(item: T, wrapKey: string) {
  return z.union([item, z.object({ [wrapKey]: item }).transform((v) => v[wrapKey] as z.output<T>)]);
}

const ok = z.unknown().transform(() => true as const);

/** better-auth may omit `image`; the contract wants `string | null`. */
const meResponse = z.preprocess((value) => {
  const v = value as { user?: { image?: unknown } } | null;
  if (v?.user && v.user.image === undefined) return { ...v, user: { ...v.user, image: null } };
  return value;
}, meResponseSchema);

export interface RangeParams {
  from?: string;
  to?: string;
  q?: string;
}

export const api = {
  me: (signal?: AbortSignal) => request(meResponse, 'GET', routes.me.path, { signal }),

  projects: {
    list: (signal?: AbortSignal) => request(listOf(projectSchema), 'GET', routes.projects.list.path, { signal }),
    get: (projectId: string, signal?: AbortSignal) =>
      request(oneOf(projectSchema, 'project'), 'GET', pathFor(routes.projects.get.path, { projectId }), { signal }),
    create: (body: { name: string; description?: string; retentionDays: number }) =>
      request(createProjectResponseSchema, 'POST', routes.projects.create.path, { body }),
    update: (projectId: string, body: { name?: string; description?: string | null; retentionDays?: number; confirm?: string }) =>
      request(oneOf(projectSchema, 'project'), 'PATCH', pathFor(routes.projects.update.path, { projectId }), { body }) as Promise<Project>,
    remove: (projectId: string) => request(ok, 'DELETE', pathFor(routes.projects.remove.path, { projectId })),
    retention: (projectId: string, signal?: AbortSignal) =>
      request(retentionStatusSchema, 'GET', pathFor(routes.projects.retention.path, { projectId }), { signal }),
  },

  keys: {
    list: (projectId: string, signal?: AbortSignal) =>
      request(listOf(apiKeySchema), 'GET', pathFor(routes.keys.list.path, { projectId }), { signal }) as Promise<ApiKey[]>,
    create: (projectId: string, body: { name: string; kind: 'ingest' | 'read' }) =>
      request(createApiKeyResponseSchema, 'POST', pathFor(routes.keys.create.path, { projectId }), { body }),
    revoke: (projectId: string, keyId: string) => request(ok, 'DELETE', pathFor(routes.keys.revoke.path, { projectId, keyId })),
  },

  events: {
    search: (projectId: string, query: RangeParams & { cursor?: string; limit?: number; order?: 'asc' | 'desc' }, signal?: AbortSignal) =>
      request(searchResponseSchema, 'GET', pathFor(routes.events.search.path, { projectId }), { query: { ...query }, signal }),
    get: (projectId: string, eventId: string, signal?: AbortSignal) =>
      request(eventDetailSchema, 'GET', pathFor(routes.events.get.path, { projectId, eventId }), { signal }),
    /** Events with `timestamp >= since`, newest first (polling tail). */
    live: (projectId: string, query: { since: string; q?: string; limit?: number }, signal?: AbortSignal) =>
      request(z.array(eventSchema), 'GET', pathFor(routes.events.live.path, { projectId }), { query: { ...query }, signal }),
    histogram: (projectId: string, query: RangeParams & { interval?: number }, signal?: AbortSignal) =>
      request(histogramResponseSchema, 'GET', pathFor(routes.events.histogram.path, { projectId }), { query: { ...query }, signal }),
    facets: (projectId: string, query: RangeParams & { field: string; limit?: number }, signal?: AbortSignal) =>
      request(facetResponseSchema, 'GET', pathFor(routes.events.facets.path, { projectId }), { query: { ...query }, signal }),
    /** Every event sharing `context.operationId`, oldest first. */
    operation: (projectId: string, operationId: string, signal?: AbortSignal) =>
      request(z.array(eventSchema), 'GET', pathFor(routes.events.operation.path, { projectId, operationId }), { signal }),
    testEvent: (projectId: string) => request(ingestResponseSchema, 'POST', pathFor(routes.events.testEvent.path, { projectId }), { body: {} }),
    exportUrl: (projectId: string, query: RangeParams & { format: 'csv' | 'jsonl' }) =>
      withQuery(pathFor(routes.events.export.path, { projectId }), { ...query }),
  },

  overview: (projectId: string, query: RangeParams, signal?: AbortSignal) =>
    request(overviewResponseSchema, 'GET', pathFor(routes.overview.path, { projectId }), { query: { ...query }, signal }),

  entities: {
    list: (projectId: string, query: { kind: EntityKind; q?: string; type?: string; limit?: number; cursor?: string }, signal?: AbortSignal) =>
      request(entityListResponseSchema, 'GET', pathFor(routes.entities.list.path, { projectId }), { query: { ...query }, signal }),
    profile: (projectId: string, kind: EntityKind, entityId: string, query: RangeParams, signal?: AbortSignal) =>
      request(entityProfileSchema, 'GET', pathFor(routes.entities.profile.path, { projectId, kind, entityId }), { query: { ...query }, signal }),
  },

  fields: (projectId: string, query: RangeParams, signal?: AbortSignal) =>
    request(fieldsResponseSchema, 'GET', pathFor(routes.fields.path, { projectId }), { query: { ...query }, signal }),

  views: {
    list: (projectId: string, signal?: AbortSignal) =>
      request(listOf(savedViewSchema), 'GET', pathFor(routes.views.list.path, { projectId }), { signal }) as Promise<SavedView[]>,
    create: (projectId: string, body: { name: string; description: string | null; state: SavedView['state'] }) =>
      request(oneOf(savedViewSchema, 'view'), 'POST', pathFor(routes.views.create.path, { projectId }), { body }) as Promise<SavedView>,
    remove: (projectId: string, viewId: string) => request(ok, 'DELETE', pathFor(routes.views.remove.path, { projectId, viewId })),
  },

  workspaceActivity: (query: RangeParams & { cursor?: string; limit?: number }, signal?: AbortSignal) =>
    request(searchResponseSchema, 'GET', routes.workspaceActivity.path, { query: { ...query }, signal }),
};
