# @logbird/hono

## Requirements

- **hono 4.12.3 or later in 4.x** (peer `^4.12.3`), Node 20 or later. The floor is the lowest hono with which this
  package's published types check under `strict` and `skipLibCheck: false` (tested at the floor and at the latest 4.x):
  - below 4.5.0, this package's `MiddlewareHandler<{ Variables: AuditVariables }>` fails hono's `Env` constraint;
  - from 4.5.0 to 4.12.2, hono's own declarations need DOM types (`RequestInfo`) that a Node project without the DOM
    library lacks;
  - 4.12.3 and later pass.
- Install `@logbird/sdk` too: your code imports the `Logbird` client from it.

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
`useOperationHeader`, `useRequestIdHeader`, `onError(error)`, `autoTrack: { methods?: string[], skip?: (c) => boolean }`. Defaults track POST/PUT/PATCH/DELETE.
The SDK reads the inbound `x-logbird-operation` and `x-request-id` headers only with `useOperationHeader` and `useRequestIdHeader` (off by default): any caller can send these headers, so enable them only behind a trusted ingress that sets them itself or strips or overwrites what a client sent.
The flags set only the fallback: an id set on the event, then a `requestId(c)` / `operationId(c)` resolver that returns a value, take precedence; otherwise the header, when its flag is on and its value is at most 256 characters, and a generated UUID last.
Use authenticated context for resolvers. Headers only supply correlation, never authorization.
Workers executionCtx.waitUntil flushes queued events after responses; Node/Bun own their shutdown lifecycle.
See [design](../../../docs/integrations.md) and [example](../../../examples/hono).

## Per-route authentication

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
