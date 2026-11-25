import { snapshotTrail, type TrailInput, type TrailQuery, trailQuery } from '@logbird/sdk/read';
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
/** The composable's options: the Vue trail options without the fetcher; `range` may be absent on an empty trail. */
export type NuxtAuditTrailOptions = Omit<AuditTrailOptions, 'fetcher' | 'range'> & Pick<TrailInput, 'range'>;
export function useAuditTrail(options: MaybeRefOrGetter<NuxtAuditTrailOptions>) {
  const request = useRequestFetch();
  // One stable fetcher, bound to the fixed route: rows and cursor belong to it.
  const fetcher: AuditFetcher = (query, signal) => request('/api/_logbird/events', { query, signal });
  return useAuditTrailRequests(() => {
    const input = toValue(options);
    const session = input.session;
    // The boundary: every trail field read once into a frozen snapshot; the rest uses only the snapshot.
    const trail = snapshotTrail(input, 'useAuditTrail');
    const empty = !trail.target && trail.actor === undefined && trail.tenant === undefined && trail.q === undefined;
    // An empty trail is decided by the route's authorize hook, whose trailQuery names the window; any bounds given here
    // are forwarded for it to use. A trail with a selector is built here, so it must name its window (trailQuery).
    // Only the snapshot's own fields: nothing inherited through Object.prototype can add a window or an order.
    const range = Object.hasOwn(trail, 'range') ? trail.range : undefined;
    const bounds =
      range && typeof range === 'object'
        ? { ...(Object.hasOwn(range, 'from') ? { from: range.from } : {}), ...(Object.hasOwn(range, 'to') ? { to: range.to } : {}) }
        : {};
    const order = Object.hasOwn(trail, 'order') ? trail.order : undefined;
    // A trail with a selector is rebuilt from the snapshot's own fields (null prototypes), so the window rule sees only
    // what the caller gave.
    const own = Object.assign(
      Object.create(null),
      trail,
      range && typeof range === 'object' ? { range: Object.assign(Object.create(null), bounds) } : {},
    );
    const limit = Object.hasOwn(trail, 'limit') ? trail.limit : undefined;
    // Null prototypes all the way to the fetcher: no field it lacks can be read through Object.prototype later.
    const query = empty
      ? Object.assign(Object.create(null), { ...bounds, ...(order ? { order } : {}), ...(limit === undefined ? {} : { limit }) })
      : trailQuery(own as TrailQuery);
    return { query, fetcher, session };
  });
}
