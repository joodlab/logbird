import type { EntityKind, EntitySort, QueryLang } from '@logbird/contracts';
import { infiniteQueryOptions, keepPreviousData, queryOptions } from '@tanstack/react-query';
import { authClient } from '@/lib/auth-client';
import { isBudgetLimit, isOverBudget } from '@/lib/query-budget';
import { resolveRange } from '@/lib/range';
import { api, langParam } from './client';
import { ApiRequestError, isBusyError, isTimeoutError, withDeadline } from './errors';

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

/** A busy project (503 project_busy / retention_unavailable) clears on its own: keep retrying for about a minute. */
export const BUSY_RETRIES = 12;

/** Session bootstrap deadline: past it the boot screen turns into an error with Retry. */
export const SESSION_DEADLINE_MS = 15_000;

/**
 * Shared retry policy: never retry 4xx, a request that already hit its client deadline, or a confirmed resource limit
 * (`invalid_query` / `limit`: an identical scan fails the same way); retry busy projects patiently, and give other
 * failures (network, 5xx including a transient `query_unavailable`) two more tries.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isBusyError(error)) return failureCount < BUSY_RETRIES;
  if (isTimeoutError(error) || isBudgetLimit(error)) return false;
  return !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) && failureCount < 2;
}

/**
 * Retry policy for summaries under a page banner with its own Retry (the support agent page): also skip
 * `query_unavailable`, usually a storage timeout for a long range, so the banner shows at once instead of after three
 * identical scans. Everything else follows `shouldRetry`.
 */
export function summaryRetry(failureCount: number, error: unknown): boolean {
  return !isOverBudget(error) && shouldRetry(failureCount, error);
}

/** Exponential backoff capped at 10 s, never sooner than the server's `Retry-After`. */
export function retryDelay(failureCount: number, error: unknown): number {
  const backoff = Math.min(1000 * 2 ** failureCount, 10_000);
  const floor = error instanceof ApiRequestError && error.retryAfter !== null ? error.retryAfter * 1000 : 0;
  return Math.min(Math.max(backoff, floor), 30_000);
}

export const meQuery = () =>
  queryOptions({
    queryKey: keys.me,
    // No abort signal: route guards await this query, and an unmounting observer must not cancel it.
    // better-auth's get-session answers 200/null when signed out, so a signed-out visit never
    // produces a failed request; /api/me is only called with a live session.
    queryFn: async () => {
      const session = await withDeadline(authClient.getSession(), SESSION_DEADLINE_MS, 'The Logbird server');
      // A 5xx from get-session means "could not check", not "signed out": show an error with Retry, not /login.
      if (session.error && (session.error.status ?? 0) >= 500)
        throw new ApiRequestError(
          session.error.status,
          'session_unavailable',
          'The Logbird server could not check your session. Try again in a moment.',
        );
      if (!session.data) throw new ApiRequestError(401, 'unauthorized', 'Sign in to continue.');
      return api.me();
    },
    staleTime: 60_000,
    retry: shouldRetry,
  });

export const projectsQuery = () =>
  queryOptions({
    queryKey: keys.projects,
    queryFn: () => api.projects.list(),
    staleTime: 30_000,
    retry: shouldRetry,
  });

export const projectQuery = (projectId: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'detail'] as const,
    queryFn: () => api.projects.get(projectId),
    staleTime: 30_000,
    retry: shouldRetry,
  });

/**
 * Retention status (oldest stored event, last and next purge). With `preview` (days) the server
 * also counts exactly how many events lowering retention to that window would delete.
 */
export const retentionQuery = (projectId: string, preview?: number) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'retention', preview ?? null] as const,
    queryFn: ({ signal }) => api.projects.retention(projectId, preview, signal),
    retry: shouldRetry,
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
    retry: shouldRetry,
  });

export const histogramQuery = (projectId: string, range: string, q: string, lang: QueryLang = 'query', interval?: number) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'histogram', range, q, q ? lang : 'query', interval ?? null] as const,
    queryFn: ({ signal }) => {
      const r = resolveRange(range);
      return api.events.histogram(projectId, { from: r.from, to: r.to, q: q || undefined, lang: q ? langParam(lang) : undefined, interval }, signal);
    },
    placeholderData: keepPreviousData,
    retry: shouldRetry,
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
    retry: shouldRetry,
  });

export const eventQuery = (projectId: string, eventId: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'event', eventId] as const,
    queryFn: ({ signal }) => api.events.get(projectId, eventId, signal),
    staleTime: 5 * 60_000,
    retry: shouldRetry,
  });

export const operationQuery = (projectId: string, operationId: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'operation', operationId] as const,
    queryFn: ({ signal }) => api.events.operation(projectId, operationId, signal),
    staleTime: 60_000,
    retry: shouldRetry,
  });

export const entityListQuery = (projectId: string, kind: EntityKind, q: string, type?: string, sort: EntitySort = 'events') =>
  infiniteQueryOptions({
    queryKey: [...keys.project(projectId), 'entities', kind, q, type ?? null, sort] as const,
    queryFn: ({ pageParam, signal }) =>
      api.entities.list(projectId, { kind, q: q || undefined, type: type || undefined, sort, limit: 50, cursor: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    retry: shouldRetry,
  });

export const entityProfileQuery = (projectId: string, kind: EntityKind, entityId: string, range: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'entity', kind, entityId, range] as const,
    queryFn: ({ signal }) => {
      const r = resolveRange(range);
      return api.entities.profile(projectId, kind, entityId, { from: r.from, to: r.to }, signal);
    },
    placeholderData: keepPreviousData,
    retry: shouldRetry,
  });

export const fieldsQuery = (projectId: string, range: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'fields', range] as const,
    queryFn: ({ signal }) => {
      const r = resolveRange(range);
      return api.fields(projectId, { from: r.from, to: r.to }, signal);
    },
    placeholderData: keepPreviousData,
    retry: shouldRetry,
  });

/** Values per /suggest request. A shorter answer means the list is complete and can be filtered locally. */
export const SUGGEST_LIMIT = 12;

/** Value suggestions for the query bar; cached per field + prefix so retyping is instant. */
export const suggestQuery = (projectId: string, field: string, prefix: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'suggest', field, prefix] as const,
    queryFn: ({ signal }) => api.suggest(projectId, { field, prefix: prefix || undefined, limit: SUGGEST_LIMIT }, signal),
    staleTime: 60_000,
    retry: false,
  });

export const keysQuery = (projectId: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'keys'] as const,
    queryFn: () => api.keys.list(projectId),
    retry: shouldRetry,
  });

export const viewsQuery = (projectId: string) =>
  queryOptions({
    queryKey: [...keys.project(projectId), 'views'] as const,
    queryFn: () => api.views.list(projectId),
    retry: shouldRetry,
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
    retry: shouldRetry,
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
    retry: shouldRetry,
  });

export const workspaceSetupQuery = () =>
  queryOptions({
    queryKey: keys.workspaceSetup,
    queryFn: ({ signal }) => api.workspaceSetup(signal),
    staleTime: 0,
    retry: shouldRetry,
  });

/** Invite links of the active workspace (admin-only endpoint: only enable it for owners/admins). */
export const inviteLinksQuery = (organizationId: string | null | undefined) =>
  queryOptions({
    queryKey: [...keys.organization, organizationId ?? 'none', 'invite-links'] as const,
    queryFn: ({ signal }) => api.inviteLinks.list(signal),
    staleTime: 15_000,
    retry: shouldRetry,
  });

export const inviteLinkPreviewQuery = (token: string) =>
  queryOptions({
    queryKey: ['invite-link', token] as const,
    queryFn: ({ signal }) => api.inviteLinks.preview(token, signal),
    retry: shouldRetry,
  });

export const invitationPreviewQuery = (invitationId: string) =>
  queryOptions({
    queryKey: ['invitation', invitationId] as const,
    queryFn: ({ signal }) => api.invitations.preview(invitationId, signal),
    retry: shouldRetry,
  });
