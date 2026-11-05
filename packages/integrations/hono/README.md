# @trailmark/hono

```ts
import { Hono } from 'hono';
import { Trailmark } from '@trailmark/sdk';
import { trailmark, type AuditVariables } from '@trailmark/hono';
const client = new Trailmark({ endpoint: process.env.TRAILMARK_ENDPOINT!, apiKey: process.env.TRAILMARK_INGEST_KEY!, onError: console.error });
const capture = trailmark({ client, actor: c => ({ type: 'user', id: 'resolved-session-user' }), tenant: c => ({ id: 'resolved-session-tenant' }), autoTrack: {} });
const app = new Hono<{ Variables: AuditVariables }>();
app.use(capture);
app.post('/records', c => { c.var.audit('record.created', { targets: [{ type: 'record', id: '123' }] }); return c.json({ ok: true }); });
// In the host's shutdown handler, await capture.shutdown().
```

Options: `client`, required `actor(c)` and `tenant(c)` resolvers (sync/async), optional `executor(c)`,
`onError(error)`, `autoTrack: { methods?: string[], skip?: (c) => boolean }`. Defaults track POST/PUT/PATCH/DELETE.
Use authenticated context for resolvers. Headers only supply correlation, never authorization.
Workers executionCtx.waitUntil flushes queued events after responses; Node/Bun own their shutdown lifecycle.
See [design](../../../docs/integrations.md) and [example](../../../examples/hono).
