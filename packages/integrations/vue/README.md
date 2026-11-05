# @trailmark/vue

```ts
import { useAuditTrail } from '@trailmark/vue';
const trail = useAuditTrail({
  target: { type: 'record', id: '123' },
  fetcher: async (query, signal) => {
    const response = await fetch(`/api/history?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k,v]) => [k, String(v)]))}`, { signal });
    if (!response.ok) throw new Error(`History HTTP ${response.status}`);
    return response.json();
  },
});
```

`AuditTrailOptions`: required fetcher(query, signal), optional target `{ id, type? }`, actor, tenant,
q, range `{ from, to }`, limit. Pass a ref/getter for reactive options. Returned refs: data, loading,
error, nextCursor; methods: refresh(), loadMore(). Unmount cancels requests; stale responses cannot
replace newer selectors. Pagination deduplicates event IDs.

`AuditTimeline` accepts `options` and a default slot receiving the same state. It renders no markup.
Ingest and read keys stay on your backend. Authenticate the browser request, authorize tenant and
record, then call `readAuditTrail` from `@trailmark/sdk/read` on the server with an enforced query.
Never trust a browser's tenant or q as authorization. Proxy errors should keep their HTTP failure status.
See [design](../../../docs/integrations.md) and [example](../../../examples/vue).
