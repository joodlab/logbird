# @trailmark/tanstack-start

Server-only setup:
```ts
import { createStart, createServerFn } from '@tanstack/react-start';
import { Trailmark } from '@trailmark/sdk';
import { trailmark, readAuditTrail, trailQuery } from '@trailmark/tanstack-start';
const capture = trailmark({ client: new Trailmark({ endpoint: process.env.TRAILMARK_ENDPOINT!, apiKey: process.env.TRAILMARK_INGEST_KEY!, onError: console.error }), actor: request => ({ id: 'resolved-session-user', type: 'user' }), tenant: request => ({ id: 'resolved-session-tenant' }) });
export const startInstance = createStart(() => ({ requestMiddleware: [capture.requestMiddleware] }));
export const update = createServerFn({ method: 'POST' }).middleware([capture.functionMiddleware]).handler(({ context }) => {
  context.audit('record.updated', { targets: [{ type: 'record', id: '123' }] });
  return { ok: true };
});
```

API route middleware can use `capture.requestMiddleware` and `context.audit` too.
Options are `CaptureOptions<Request>`: client, required actor/tenant, optional executor and onError.
Await `capture.shutdown()` in the host's lifecycle. Never return context.audit to the browser.
For a history server function, authorize the record then return
`readAuditTrail({ endpoint, readKey }, trailQuery({ target: { type: 'record', id }, tenant }))`.
Read failures reject normally; they are not disguised as empty history.
See [design](../../../docs/integrations.md) and [example](../../../examples/tanstack-start).
