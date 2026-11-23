import { snapshotTrail, trailQuery } from '@logbird/sdk/read';
import { type AuditFetcher, type AuditTrailOptions, useAuditTrailRequests } from '@logbird/vue';
import { type MaybeRefOrGetter, toValue } from 'vue';
import { useRequestFetch } from '#imports';

/**
 * The trail through this app's read route (/api/_logbird/events). The route's authorize hook decides the scope on the
 * server, so a trail with no selector and no query is sent as is (the route refuses a trusted query without `q`);
 * anything else is built by trailQuery, so a selector passed without a value still throws on the client (#263).
 *
 * Pass `session`: a string that changes whenever `authorize` would return a different scope, so the user and the active
 * tenant or workspace, for example `JSON.stringify([user.id, workspace.id])`. A change drops the shown rows, the cursor
 * and any read in flight. Without it, the route still re-authorizes every request, but the rows already on screen stay
 * until the next reload or trail change, and "load more" appends the new scope's next page to them.
 */
export function useAuditTrail(options: MaybeRefOrGetter<Omit<AuditTrailOptions, 'fetcher'>>) {
  const request = useRequestFetch();
  // One stable fetcher, bound to the fixed route: rows and cursor belong to it.
  const fetcher: AuditFetcher = (query, signal) => request('/api/_logbird/events', { query, signal });
  return useAuditTrailRequests(() => {
    const input = toValue(options);
    const session = input.session;
    // The boundary: every trail field read once into a frozen snapshot; the rest uses only the snapshot.
    const trail = snapshotTrail(input, 'useAuditTrail');
    const empty = !trail.target && trail.actor === undefined && trail.tenant === undefined && trail.q === undefined;
    return { query: empty ? { ...trail.range, limit: trail.limit } : trailQuery(trail), fetcher, session };
  });
}
