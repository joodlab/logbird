import {
  type ApiKey,
  acceptInviteLinkResponseSchema,
  apiKeySchema,
  createApiKeyResponseSchema,
  createProjectResponseSchema,
  type EntityKind,
  type EntitySort,
  type ExportQuery,
  entityListResponseSchema,
  entityProfileSchema,
  eventDetailSchema,
  eventSchema,
  exportStatusSchema,
  facetResponseSchema,
  fieldsResponseSchema,
  histogramResponseSchema,
  type InviteLink,
  ingestResponseSchema,
  invitationPreviewSchema,
  inviteLinkPreviewSchema,
  inviteLinkSchema,
  meResponseSchema,
  overviewResponseSchema,
  type Project,
  projectSchema,
  projectSetupSchema,
  type QueryLang,
  retentionStatusSchema,
  routes,
  type SavedView,
  sampleDataResponseSchema,
  savedViewSchema,
  searchResponseSchema,
  suggestResponseSchema,
  workspaceSetupSchema,
} from '@logbird/contracts';
import { z } from 'zod';
import { timeoutError, toApiError } from './errors';

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

/**
 * Longest the console waits for one API response. Past it the request is aborted and surfaces as a `timeout` error
 * with a retry, instead of a spinner that never ends.
 */
export const REQUEST_DEADLINE_MS = 30_000;

async function request<S extends z.ZodType>(schema: S, method: string, path: string, options: RequestOptions = {}): Promise<z.output<S>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_DEADLINE_MS);
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  try {
    const response = await fetch(withQuery(path, options.query), {
      method,
      credentials: 'same-origin',
      signal: controller.signal,
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
  } catch (error) {
    if (timedOut) throw timeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

/** Lists are `{ data: [...] }` (contracts/console.ts). */
function listOf<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item) }).transform((v) => v.data);
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
  /** Language of `q`; omitted = the query language. */
  lang?: QueryLang;
}

/** `lang` is sent only for SQL so query-language URLs stay unchanged. */
export const langParam = (lang: QueryLang | undefined) => (lang === 'sql' ? 'sql' : undefined);

export const api = {
  me: (signal?: AbortSignal) => request(meResponse, 'GET', routes.me.path, { signal }),

  projects: {
    list: (signal?: AbortSignal) => request(listOf(projectSchema), 'GET', routes.projects.list.path, { signal }),
    get: (projectId: string, signal?: AbortSignal) => request(projectSchema, 'GET', pathFor(routes.projects.get.path, { projectId }), { signal }),
    create: (body: { name: string; description?: string; retentionDays: number }) =>
      request(createProjectResponseSchema, 'POST', routes.projects.create.path, { body }),
    update: (
      projectId: string,
      body: {
        name?: string;
        description?: string | null;
        retentionDays?: number;
        confirm?: string;
        retentionReviewed?: true;
        setupDismissed?: boolean;
      },
    ) => request(projectSchema, 'PATCH', pathFor(routes.projects.update.path, { projectId }), { body }) as Promise<Project>,
    remove: (projectId: string, confirm: string) =>
      request(ok, 'DELETE', pathFor(routes.projects.remove.path, { projectId }), { query: { confirm } }),
    /** `preview` (days) also counts the events a lower retention window would delete. */
    retention: (projectId: string, preview?: number, signal?: AbortSignal) =>
      request(retentionStatusSchema, 'GET', pathFor(routes.projects.retention.path, { projectId }), { query: { preview }, signal }),
    /** Integration checklist, computed server-side from real state. Cheap enough to poll every few seconds. */
    setup: (projectId: string, signal?: AbortSignal) =>
      request(projectSetupSchema, 'GET', pathFor(routes.projects.setup.path, { projectId }), { signal }),
    loadSampleData: (projectId: string) => request(sampleDataResponseSchema, 'POST', pathFor(routes.projects.sampleData.path, { projectId })),
    removeSampleData: (projectId: string) => request(ok, 'DELETE', pathFor(routes.projects.removeSampleData.path, { projectId })),
  },

  /** Workspace setup summary + resumable onboarding target. */
  workspaceSetup: (signal?: AbortSignal) => request(workspaceSetupSchema, 'GET', routes.workspaceSetup.path, { signal }),

  invitations: {
    /** Public: works signed out. */
    preview: (invitationId: string, signal?: AbortSignal) =>
      request(invitationPreviewSchema, 'GET', pathFor(routes.invitations.preview.path, { invitationId }), { signal }),
  },

  /** Shareable join links. list/create/revoke: owner or admin of the active workspace. */
  inviteLinks: {
    list: (signal?: AbortSignal) => request(listOf(inviteLinkSchema), 'GET', routes.inviteLinks.list.path, { signal }) as Promise<InviteLink[]>,
    create: (body: { role: 'member' | 'admin'; expiresInDays: number; maxUses: number | null; allowedDomain: string | null }) =>
      request(inviteLinkSchema, 'POST', routes.inviteLinks.create.path, { body }) as Promise<InviteLink>,
    revoke: (linkId: string) => request(ok, 'DELETE', pathFor(routes.inviteLinks.revoke.path, { linkId })),
    /** Public: works signed out. */
    preview: (token: string, signal?: AbortSignal) =>
      request(inviteLinkPreviewSchema, 'GET', pathFor(routes.inviteLinks.preview.path, { token }), { signal }),
    /** Joins the signed-in user and makes the workspace active on the session. */
    accept: (token: string) => request(acceptInviteLinkResponseSchema, 'POST', pathFor(routes.inviteLinks.accept.path, { token })),
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
    live: (projectId: string, query: { since: string; q?: string; lang?: QueryLang; limit?: number }, signal?: AbortSignal) =>
      request(z.array(eventSchema), 'GET', pathFor(routes.events.live.path, { projectId }), { query: { ...query }, signal }),
    histogram: (projectId: string, query: RangeParams & { interval?: number }, signal?: AbortSignal) =>
      request(histogramResponseSchema, 'GET', pathFor(routes.events.histogram.path, { projectId }), { query: { ...query }, signal }),
    facets: (projectId: string, query: RangeParams & { field: string; limit?: number }, signal?: AbortSignal) =>
      request(facetResponseSchema, 'GET', pathFor(routes.events.facets.path, { projectId }), { query: { ...query }, signal }),
    /** Every event sharing `context.operationId`, oldest first. */
    operation: (projectId: string, operationId: string, signal?: AbortSignal) =>
      request(z.array(eventSchema), 'GET', pathFor(routes.events.operation.path, { projectId, operationId }), { signal }),
    testEvent: (projectId: string) => request(ingestResponseSchema, 'POST', pathFor(routes.events.testEvent.path, { projectId }), { body: {} }),
    exportUrl: (projectId: string, query: ExportQuery) => withQuery(pathFor(routes.events.export.path, { projectId }), { ...query }),
  },

  overview: (projectId: string, query: RangeParams, signal?: AbortSignal) =>
    request(overviewResponseSchema, 'GET', pathFor(routes.overview.path, { projectId }), { query: { ...query }, signal }),

  entities: {
    list: (
      projectId: string,
      query: { kind: EntityKind; q?: string; type?: string; sort?: EntitySort; limit?: number; cursor?: string },
      signal?: AbortSignal,
    ) => request(entityListResponseSchema, 'GET', pathFor(routes.entities.list.path, { projectId }), { query: { ...query }, signal }),
    profile: (projectId: string, kind: EntityKind, entityId: string, query: RangeParams, signal?: AbortSignal) =>
      request(entityProfileSchema, 'GET', pathFor(routes.entities.profile.path, { projectId, kind, entityId }), { query: { ...query }, signal }),
  },

  fields: (projectId: string, query: RangeParams, signal?: AbortSignal) =>
    request(fieldsResponseSchema, 'GET', pathFor(routes.fields.path, { projectId }), { query: { ...query }, signal }),

  /** Value autocomplete for the query bar. */
  suggest: (projectId: string, query: { field: string; prefix?: string; limit?: number }, signal?: AbortSignal) =>
    request(suggestResponseSchema, 'GET', pathFor(routes.suggest.path, { projectId }), { query: { ...query }, signal }),

  views: {
    list: (projectId: string, signal?: AbortSignal) =>
      request(listOf(savedViewSchema), 'GET', pathFor(routes.views.list.path, { projectId }), { signal }) as Promise<SavedView[]>,
    create: (projectId: string, body: { name: string; description: string | null; state: SavedView['state'] }) =>
      request(savedViewSchema, 'POST', pathFor(routes.views.create.path, { projectId }), { body }) as Promise<SavedView>,
    remove: (projectId: string, viewId: string) => request(ok, 'DELETE', pathFor(routes.views.remove.path, { projectId, viewId })),
  },

  workspaceActivity: (query: RangeParams & { cursor?: string; limit?: number }, signal?: AbortSignal) =>
    request(searchResponseSchema, 'GET', routes.workspaceActivity.path, { query: { ...query }, signal }),
  exportStatus: (exportId: string, signal?: AbortSignal) =>
    request(exportStatusSchema, 'GET', pathFor(routes.exportStatus.path, { exportId }), { signal }),
};
