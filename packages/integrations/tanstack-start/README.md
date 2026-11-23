# @logbird/tanstack-start

Server-only setup:
```ts
import { createStart, createServerFn } from '@tanstack/react-start';
import { Logbird } from '@logbird/sdk';
import { logbird, readAuditTrail, trailQuery } from '@logbird/tanstack-start';
const capture = logbird({ client: new Logbird({ endpoint: (process.env.LOGBIRD_ENDPOINT)!, apiKey: (process.env.LOGBIRD_INGEST_KEY)!, onError: console.error }), actor: request => ({ id: 'resolved-session-user', type: 'user' }), tenant: request => ({ id: 'resolved-session-tenant' }) });
export const startInstance = createStart(() => ({ requestMiddleware: [capture.requestMiddleware] }));
export const update = createServerFn({ method: 'POST' }).middleware([capture.functionMiddleware]).handler(({ context }) => {
  context.audit('record.updated', { targets: [{ type: 'record', id: '123' }] });
  return { ok: true };
});
```

API route middleware can use `capture.requestMiddleware` and `context.audit` too.
Options are `CaptureOptions<Request>`: client, required actor/tenant, optional executor and onError, and
`useOperationHeader` / `useRequestIdHeader`: the SDK reads the inbound `x-logbird-operation` and `x-request-id` headers only
with those (off by default): any caller can send these headers, so enable them only behind a trusted ingress that sets them itself or strips or overwrites what a client sent.
The flags set only the fallback: an id set on the event, then a `requestId` / `operationId` resolver that returns a value, take
precedence; otherwise each id is a generated UUID.
Await `capture.shutdown()` in the host's lifecycle. Never return context.audit to the browser.
For a history server function, authorize the record then return
`readAuditTrail({ endpoint, readKey }, trailQuery({ target: { type: 'record', id }, tenant }))`.
`trailQuery` throws a `TypeError` (and nothing is read) if `id` or `tenant` is passed without a value.
Read failures reject normally; they are not disguised as empty history.
See [design](../../../docs/integrations.md) and [example](../../../examples/tanstack-start).
