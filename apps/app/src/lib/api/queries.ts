import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';
import type { EntityKind, EntitySort, QueryLang } from '@trailmark/contracts';
import { authClient } from '@/lib/auth-client';
import { resolveRange } from '@/lib/range';
import { api, langParam } from './client';
import { ApiRequestError } from './errors';

/**
 * Query keys are hierarchical so one invalidation clears a whole project:
 *   ['projects', projectId, <resource>, ...params]
 * Ranges are keyed by their *string* ("24h"), and resolved to concrete bounds inside the
 * query function, so a relative range refreshes on refetch without changing identity.
 */
export const keys = {
  me: ['me'] as const,
  projects: ['projects'] as const,
  project: (projectId: string) => ['projects', projectId] as const,
  workspaceActivity: (range: string, q: string) => ['workspace-activity', range, q] as const,
  workspaceSetup: ['workspace-setup'] as const,
  organization: ['organization'] as const,
};

const noRetryOn4xx = (failureCount: number, error: unknown) =>
  !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) && failureCount < 2;

export const meQuery = () =>
  queryOptions({
    queryKey: keys.me,
    // No abort signal: route guards await this query, and an unmounting observer must not cancel it.
    // better-auth's get-session answers 200/null when signed out, so a signed-out visit never
    // produces a failed request; /api/me is only called with a live session.
    queryFn: async () => {
      const session = await authClient.getSession();
      if (!session.data) throw new ApiRequestError(401, 'unauthorized', 'Sign in to continue.');
      return api.me();
    },
    staleTime: 60_000,
    retry: noRetryOn4xx,
  });

export const projectsQuery = () =>
  queryOptions({
    queryKey: keys.projects,
    queryFn: () => api.projects.list(),
    staleTime: 30_000,
    retry: noRetryOn4xx,
  });

export const projectQuery = (projectId: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'detail'] as const,
    queryFn: () => api.projects.get(projectId),
    staleTime: 30_000,
    retry: noRetryOn4xx,
  });

/**
 * Retention status (oldest stored event, last and next purge). With `preview` (days) the server
 * also counts exactly how many events lowering retention to that window would delete.
 */
export const retentionQuery = (projectId: string, preview?: number) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'retention', preview ?? null] as const,
    queryFn: ({ signal }) => api.projects.retention(projectId, preview, signal),
    retry: noRetryOn4xx,
  });

export const overviewQuery = (projectId: string, range: string, q = '') =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'overview', range, q] as const,
    queryFn: ({ signal }) => {
      const r = resolveRange(range);
      return api.overview(projectId, { from: r.from, to: r.to, q: q || undefined }, signal);
    },
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

export const PAGE_SIZE = 100;

export const eventsInfiniteQuery = (projectId: string, range: string, q: string, lang: QueryLang = 'query') =>
  infiniteQueryOptions({
    queryKey: [...keys.project(projectId), 'events', range, q, q ? lang : 'query'] as const,
    queryFn: ({ pageParam, signal }) => {
      const r = resolveRange(range);
      return api.events.search(
        projectId,
        { from: r.from, to: r.to, q: q || undefined, lang: q ? langParam(lang) : undefined, cursor: pageParam, limit: PAGE_SIZE },
        signal,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    retry: noRetryOn4xx,
  });

export const histogramQuery = (projectId: string, range: string, q: string, lang: QueryLang = 'query', interval?: number) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'histogram', range, q, q ? lang : 'query', interval ?? null] as const,
    queryFn: ({ signal }) => {
      const r = resolveRange(range);
      return api.events.histogram(projectId, { from: r.from, to: r.to, q: q || undefined, lang: q ? langParam(lang) : undefined, interval }, signal);
    },
    placeholderData: keepPreviousData,
    retry: noRetryOn4xx,
  });

export const facetQuery = (projectId: string, field: string, range: string, q: string, limit = 8, lang: QueryLang = 'query') =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'facet', field, range, q, limit, q ? lang : 'query'] as const,
    queryFn: ({ signal }) => {
      const r = resolveRange(range);
      return api.events.facets(projectId, { field, from: r.from, to: r.to, q: q || undefined, lang: q ? langParam(lang) : undefined, limit }, signal);
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: noRetryOn4xx,
  });

export const eventQuery = (projectId: string, eventId: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'event', eventId] as const,
    queryFn: ({ signal }) => api.events.get(projectId, eventId, signal),
    staleTime: 5 * 60_000,
    retry: noRetryOn4xx,
  });

export const operationQuery = (projectId: string, operationId: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'operation', operationId] as const,
    queryFn: ({ signal }) => api.events.operation(projectId, operationId, signal),
    staleTime: 60_000,
    retry: noRetryOn4xx,
  });

export const entityListQuery = (projectId: string, kind: EntityKind, q: string, type?: string, sort: EntitySort = 'events') =>
  infiniteQueryOptions({
    queryKey: [...keys.project(projectId), 'entities', kind, q, type ?? null, sort] as const,
    queryFn: ({ pageParam, signal }) =>
      api.entities.list(projectId, { kind, q: q || undefined, type: type || undefined, sort, limit: 50, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    retry: noRetryOn4xx,
  });

export const entityProfileQuery = (projectId: string, kind: EntityKind, entityId: string, range: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'entity', kind, entityId, range] as const,
    queryFn: ({ signal }) => {
      const r = resolveRange(range);
      return api.entities.profile(projectId, kind, entityId, { from: r.from, to: r.to }, signal);
    },
    placeholderData: keepPreviousData,
    retry: noRetryOn4xx,
  });

export const fieldsQuery = (projectId: string, range: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'fields', range] as const,
    queryFn: ({ signal }) => {
      const r = resolveRange(range);
      return api.fields(projectId, { from: r.from, to: r.to }, signal);
    },
    placeholderData: keepPreviousData,
    retry: noRetryOn4xx,
  });

/** Value suggestions for the query bar; cached per field + prefix so retyping is instant. */
export const suggestQuery = (projectId: string, field: string, prefix: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'suggest', field, prefix] as const,
    queryFn: ({ signal }) => api.suggest(projectId, { field, prefix: prefix || undefined, limit: 12 }, signal),
    staleTime: 60_000,
    retry: false,
  });

export const keysQuery = (projectId: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'keys'] as const,
    queryFn: () => api.keys.list(projectId),
    retry: noRetryOn4xx,
  });

export const viewsQuery = (projectId: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'views'] as const,
    queryFn: () => api.views.list(projectId),
    retry: noRetryOn4xx,
  });

export const workspaceActivityQuery = (range: string, q: string) =>
  infiniteQueryOptions({
    queryKey: keys.workspaceActivity(range, q),
    queryFn: ({ pageParam, signal }) => {
      const r = resolveRange(range);
      return api.workspaceActivity({ from: r.from, to: r.to, q: q || undefined, cursor: pageParam, limit: PAGE_SIZE }, signal);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    retry: noRetryOn4xx,
  });

/**
 * Project setup checklist. With `pollUntilFirstEvent` (ms) the first-event step polls quickly while nothing has
 * arrived yet, then drops back to the normal minute refresh.
 */
export const projectSetupQuery = (projectId: string, options: { pollUntilFirstEvent?: number } = {}) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'setup'] as const,
    queryFn: ({ signal }) => api.projects.setup(projectId, signal),
    staleTime: 10_000,
    refetchInterval: (query) => (options.pollUntilFirstEvent && !query.state.data?.ingest.firstEventAt ? options.pollUntilFirstEvent : 60_000),
    refetchIntervalInBackground: Boolean(options.pollUntilFirstEvent),
    retry: noRetryOn4xx,
  });

export const workspaceSetupQuery = () =>
  queryOptions({
    queryKey: keys.workspaceSetup,
    queryFn: ({ signal }) => api.workspaceSetup(signal),
    staleTime: 0,
    retry: noRetryOn4xx,
  });

/** Invite links of the active workspace (admin-only endpoint: only enable it for owners/admins). */
export const inviteLinksQuery = (organizationId: string | null | undefined) =>
  queryOptions({
    queryKey: [...keys.organization, organizationId ?? 'none', 'invite-links'] as const,
    queryFn: ({ signal }) => api.inviteLinks.list(signal),
    staleTime: 15_000,
    retry: noRetryOn4xx,
  });

export const inviteLinkPreviewQuery = (token: string) =>
  queryOptions({
    queryKey: ['invite-link', token] as const,
    queryFn: ({ signal }) => api.inviteLinks.preview(token, signal),
    retry: noRetryOn4xx,
  });

export const invitationPreviewQuery = (invitationId: string) =>
  queryOptions({
    queryKey: ['invitation', invitationId] as const,
    queryFn: ({ signal }) => api.invitations.preview(invitationId, signal),
    retry: noRetryOn4xx,
  });
