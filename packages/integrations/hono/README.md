# @logbird/hono

```ts
import { Hono } from 'hono';
import { Logbird } from '@logbird/sdk';
import { logbird, type AuditVariables } from '@logbird/hono';
const client = new Logbird({ endpoint: (process.env.LOGBIRD_ENDPOINT)!, apiKey: (process.env.LOGBIRD_INGEST_KEY)!, onError: console.error });
const capture = logbird({ client, actor: c => ({ type: 'user', id: 'resolved-session-user' }), tenant: c => ({ id: 'resolved-session-tenant' }), autoTrack: {} });
const app = new Hono<{ Variables: AuditVariables }>();
app.use(capture);
app.post('/records', c => { c.var.audit('record.created', { targets: [{ type: 'record', id: '123' }] }); return c.json({ ok: true }); });
// In the host's shutdown handler, await capture.shutdown().
```

Options: `client`, optional `actor(c)`, `impersonator(c)` and `tenant(c)` resolvers (sync/async), optional `executor(c)`, `ip(c)`, `requestId(c)`, `operationId(c)`,
`onError(error)`, `autoTrack: { methods?: string[], skip?: (c) => boolean }`. Defaults track POST/PUT/PATCH/DELETE.
Use authenticated context for resolvers. Headers only supply correlation, never authorization.
Workers executionCtx.waitUntil flushes queued events after responses; Node/Bun own their shutdown lifecycle.
See [design](../../../docs/integrations.md) and [example](../../../examples/hono).

## Per-route authentication (StayDesk pattern)

```ts
const app = new Hono<{ Variables: AuditVariables & {
  user: { id: string } | undefined; requestId: string;
} }>();
// Host logging middleware sets requestId before capture.
app.use(hostLoggingMiddleware);
const capture = logbird({
  client,
  actor: c => c.get('user') ? { type: 'user', id: c.get('user').id } : undefined,
  requestId: c => c.get('requestId'),
  autoTrack: {},
});
app.use(capture);
app.post('/records', async (c, next) => {
  const user = await authenticate(c.req.raw);
  if (!user) return c.text('Unauthorized', 401);
  c.set('user', user);
  await next();
}, c => {
  const eventId = c.var.audit('record.created');
  return c.json({ eventId });
});
```

Resolvers run for each audit call; automatic tracking after the route also sees the guard's
identity. Explicit event actor/tenant/executor/context.ip skip the corresponding resolver.
Failures omit only the failing field and report onError. audit returns the event id immediately;
use `await c.var.audit.carrier({ parentEventId: eventId })` to propagate into worker data.
Edge waitUntil drains pending context resolution before flushing; Node hosts await
capture.shutdown(). See the [SDK options and worker guide](../../sdk/README.md).
