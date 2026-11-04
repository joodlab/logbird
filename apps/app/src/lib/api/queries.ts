import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';
import type { EntityKind } from '@trailmark/contracts';
import { resolveRange } from '@/lib/range';
import { api } from './client';
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
};

const noRetryOn4xx = (failureCount: number, error: unknown) =>
  !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) && failureCount < 2;

export const meQuery = () =>
  queryOptions({
    queryKey: keys.me,
    // No abort signal: route guards await this query, and an unmounting observer must not cancel it.
    queryFn: () => api.me(),
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
 * Retention status. Servers without `GET /projects/:id/retention` (contracts/console.ts) still get
 * the oldest stored event from an ascending search; the last purge run is then unknown.
 */
export const retentionQuery = (projectId: string, retentionDays: number) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'retention', retentionDays] as const,
    queryFn: async ({ signal }) => {
      try {
        return await api.projects.retention(projectId, signal);
      } catch (error) {
        if (!(error instanceof ApiRequestError && error.status === 404)) throw error;
        const oldest = await api.events.search(
          projectId,
          { from: new Date(Date.now() - (retentionDays + 1) * 86_400_000).toISOString(), to: new Date().toISOString(), order: 'asc', limit: 1 },
          signal,
        );
        return { retentionDays, oldestEventAt: oldest.data[0]?.timestamp ?? null, lastRun: null };
      }
    },
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

export const eventsInfiniteQuery = (projectId: string, range: string, q: string) =>
  infiniteQueryOptions({
    queryKey: [...keys.project(projectId), 'events', range, q] as const,
    queryFn: ({ pageParam, signal }) => {
      const r = resolveRange(range);
      return api.events.search(projectId, { from: r.from, to: r.to, q: q || undefined, cursor: pageParam, limit: PAGE_SIZE }, signal);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    retry: noRetryOn4xx,
  });

export const histogramQuery = (projectId: string, range: string, q: string, interval?: number) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'histogram', range, q, interval ?? null] as const,
    queryFn: ({ signal }) => {
      const r = resolveRange(range);
      return api.events.histogram(projectId, { from: r.from, to: r.to, q: q || undefined, interval }, signal);
    },
    placeholderData: keepPreviousData,
    retry: noRetryOn4xx,
  });

export const facetQuery = (projectId: string, field: string, range: string, q: string, limit = 8) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'facet', field, range, q, limit] as const,
    queryFn: ({ signal }) => {
      const r = resolveRange(range);
      return api.events.facets(projectId, { field, from: r.from, to: r.to, q: q || undefined, limit }, signal);
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

export const entityListQuery = (projectId: string, kind: EntityKind, q: string, type?: string) =>
  infiniteQueryOptions({
    queryKey: [...keys.project(projectId), 'entities', kind, q, type ?? null] as const,
    queryFn: ({ pageParam, signal }) =>
      api.entities.list(projectId, { kind, q: q || undefined, type: type || undefined, limit: 50, cursor: pageParam }, signal),
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
