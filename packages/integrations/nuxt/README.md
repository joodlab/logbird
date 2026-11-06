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

`ModuleOptions`: endpoint, ingestKey, readKey (private runtimeConfig.logbird), hooks (server module path).
Hook types: authorize(event, query) => false | Partial<SearchQuery> (async supported), optional actor,
tenant, executor (sync/async), onError. Nitro request hooks create event.context.audit, afterResponse
registers flush with event.waitUntil, close drains the SDK. Missing identity resolvers leave identity absent.
See [design](../../../docs/integrations.md) and [example](../../../examples/nuxt).
