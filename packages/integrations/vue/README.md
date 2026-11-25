# @logbird/vue

## Install

Not on npm yet. Each [GitHub Release](https://github.com/joodlab/logbird/releases) attaches
`logbird-vue-X.Y.Z.tgz` and `logbird-sdk-X.Y.Z.tgz` with a
`SHA256SUMS` file. Download them, verify them, depend on the files and override
`@logbird/sdk` to the same tarball, as
[Install the SDK](https://github.com/joodlab/logbird/blob/master/docs/integrating-a-backend.md#install-the-sdk)
shows. Requirements: Node 20 or later, Vue 3.5.22 or later in 3.x (peer `^3.5.22`); ES modules only; the declarations are type-checked with
TypeScript 6 and 7 under `bundler` resolution. No check installs this package with that recipe
yet; the SDK and Hono recipes are the tested ones.

## Usage

```ts
import { useAuditTrail } from '@logbird/vue';
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
q, range `{ from, to }` (each a `Date`, epoch milliseconds or an ISO 8601 string), limit, session. Pass a ref/getter
for reactive options. Returned refs: data, loading, error, nextCursor; methods: refresh(), loadMore(). Unmount cancels
requests; stale responses cannot replace newer selectors. Pagination deduplicates event IDs.
Define the fetcher once (not inline in a getter): rows and cursor belong to the trail, `session` and fetcher that
produced them, and a different one starts again at page one. It is called as a plain function (no `this`): pass a
function, or a method bound once. Pass `session` (a string naming the user and active tenant) when the fetcher's scope
follows the session: a change drops the rows, the cursor and any read in flight at once. Changes are seen through
Vue reactivity, so pass a ref, a getter or a reactive object; a plain object mutated in place is not watched. Keep range
bounds stable (compute them once, for example in a ref): a getter returning `new Date()` makes every call a new trail,
so loadMore starts again at page one. An ascending trail with an open end (no `to`, or a relative `now` in `q`) can
gain newer events on later pages, because the server resolves "now" for each request.

`AuditTimeline` accepts `options` and a default slot receiving the same state. It renders no markup.
A trail with no selector and no non-blank query, or a selector passed without a value (a tenant id not loaded yet),
sets `error` and fetches nothing; it never falls back to a wider read. `useAuditTrailRequests(source)` runs a query you
build yourself, with no selector checks (Nuxt's read route uses it, because its server decides the scope); its query
still passes the SDK's input boundary. Ingest and read keys stay on your backend. Authenticate the browser request, authorize tenant and
record, then call `readAuditTrail` from `@logbird/sdk/read` on the server with an enforced query.
Never trust a browser's tenant or q as authorization. Proxy errors should keep their HTTP failure status.
See [design](../../../docs/integrations.md) and [example](../../../examples/vue).
