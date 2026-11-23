# @logbird/nuxt

```ts
// nuxt.config.ts
export default defineNuxtConfig({ modules: ['@logbird/nuxt'], logbird: {
  endpoint: 'http://127.0.0.1:4731', hooks: '/absolute/path/server/logbird.ts',
} });
// Set NUXT_LOGBIRD_INGEST_KEY and NUXT_LOGBIRD_READ_KEY in the server environment.
// server/logbird.ts
export default {
  authorize: async (event, query) => {
    // Authenticate and authorize the specific record in YOUR application first.
    // Return false on denial, otherwise a trusted SearchQuery with enforced tenant scope.
    return false;
  },
  actor: event => ({ type: 'user', id: 'resolved-session-user' }),
  tenant: event => ({ id: 'resolved-session-tenant' }),
  onError: console.error,
};
// server/api/update.post.ts
export default defineEventHandler(event => { event.context.audit('record.updated'); return { ok: true }; });
```

Auto-imported `useAuditTrail({ target: { id: '123' } })` uses the server route
`/api/_logbird/events`; SSR forwards the application's request cookies. The route denies by default,
sets private/no-store caching, and only forwards the query returned by authorize. Hooks run on the
server, not serialized runtime config. Authorize every page/cursor; tenant selectors are not a policy.
If authorize throws a `TrailQueryError` (a `TypeError`, from `trailQuery`) or returns a query with no `q`, the route answers 400 and reads
nothing. Because authorize decides the scope on the server, `useAuditTrail({})` may send an empty trail to this route;
a selector passed without a value (`tenant: undefined`) still throws on the client. Only a `TrailQueryError` from the
SDK becomes a 400; any other error in `authorize` stays a server error.
Pass `session` in the options: a string that changes whenever `authorize` would return a different scope, so the user
**and** the active tenant or workspace, for example
`` useAuditTrail(() => ({ target: { id }, session: JSON.stringify([user.value?.id ?? null, workspace.value?.id ?? null]) })) ``. When it changes, the
rows on screen, the cursor and any read in flight are dropped at once and the trail reloads. Remounting the component
with the same key (`` <AuditTrail :key="JSON.stringify([user.id, workspace.id])" /> ``; JSON keeps ids containing `:` apart) does the same. Without either, the route still
re-authorizes every request, so no response contains events the new scope may not read, but the rows already on screen
stay there until the next reload or trail change, and "load more" appends the new scope's next page to them.

`ModuleOptions`: endpoint, ingestKey, readKey (private runtimeConfig.logbird), hooks (server module path).
Hook types: authorize(event, query) => false | Partial<SearchQuery> (async supported), optional actor,
tenant, executor (sync/async), onError, useOperationHeader and useRequestIdHeader. The inbound
x-logbird-operation and x-request-id headers are used only with those two (off by default): any caller can send these headers, so enable them only behind a trusted ingress that sets them itself or strips or overwrites what a client sent. Nitro request hooks create event.context.audit, afterResponse
registers flush with event.waitUntil, close drains the SDK. Missing identity resolvers leave identity absent.
See [design](../../../docs/integrations.md) and [example](../../../examples/nuxt).
