import { trailQuery } from '@logbird/sdk/read';
import { type AuditFetcher, type AuditTrailOptions, useAuditTrailRequests } from '@logbird/vue';
import { type MaybeRefOrGetter, toValue } from 'vue';
import { useRequestFetch } from '#imports';

const SELECTORS = ['target', 'actor', 'tenant'] as const;
/**
 * The trail through this app's read route (/api/_logbird/events). The route's authorize hook decides the scope on the
 * server, so a trail with no selector key and no query is sent as is (the route refuses a trusted query without `q`);
 * anything else is built by trailQuery, so a selector passed without a value still throws on the client (#263).
 */
export function useAuditTrail(options: MaybeRefOrGetter<Omit<AuditTrailOptions, 'fetcher'>>) {
  const request = useRequestFetch();
  // One stable fetcher, bound to the fixed route: rows and cursor belong to it.
  const fetcher: AuditFetcher = (query, signal) => request('/api/_logbird/events', { query, signal });
  return useAuditTrailRequests(() => {
    const input = toValue(options);
    const q = input.q;
    const empty =
      SELECTORS.every((key) => (input as Record<string, unknown>)[key] === undefined && !(key in input)) &&
      (q === undefined || (typeof q === 'string' && !q.trim()));
    return { query: empty ? { ...input.range, limit: input.limit } : trailQuery(input), fetcher };
  });
}
