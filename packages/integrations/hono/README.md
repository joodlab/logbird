# @logbird/hono

## Requirements

- **hono 4.12.3 or later in 4.x** (peer `^4.12.3`), Node 20 or later. The floor is the lowest hono with which this
  package's published types check under `strict` and `skipLibCheck: false` (tested at the floor and at the latest 4.x):
  - below 4.5.0, this package's `MiddlewareHandler<{ Variables: AuditVariables }>` fails hono's `Env` constraint;
  - from 4.5.0 to 4.12.2, hono's own declarations need DOM types (`RequestInfo`) that a Node project without the DOM
    library lacks;
  - 4.12.3 and later pass.
- Install `@logbird/sdk` too: your code imports the `Logbird` client from it.
- ES modules only; the declarations are checked with TypeScript 6 and 7.

## Install

Not on npm yet. Each [GitHub Release](https://github.com/joodlab/logbird/releases) attaches
`logbird-hono-X.Y.Z.tgz` and `logbird-sdk-X.Y.Z.tgz` with a `SHA256SUMS` file. Download both
into `vendor/logbird/`, verify both against `SHA256SUMS` (stop if either does not print `OK`),
depend on both files, and override `@logbird/sdk` to the same SDK tarball (this package
depends on the SDK at exactly its own version, which no registry serves yet):

```jsonc
// package.json
"dependencies": {
  "@logbird/sdk": "file:vendor/logbird/logbird-sdk-X.Y.Z.tgz",
  "@logbird/hono": "file:vendor/logbird/logbird-hono-X.Y.Z.tgz",
  "hono": "4.13.21" // your application's hono: 4.12.3 or later in 4.x
}
// npm: "overrides": { "@logbird/sdk": "file:vendor/logbird/logbird-sdk-X.Y.Z.tgz" } in package.json
// pnpm: overrides: { '@logbird/sdk': file:vendor/logbird/logbird-sdk-X.Y.Z.tgz } in pnpm-workspace.yaml
```

The full recipe, with the download commands and the lockfile check, is in
[Install the SDK](https://github.com/joodlab/logbird/blob/master/docs/integrating-a-backend.md#install-the-sdk).

### pnpm 11 workspaces

Keep the verified tarballs in the app's `vendor/logbird/` when the build prunes the workspace
before installing. Put the override in the root `pnpm-workspace.yaml` and write its `file:`
path from the workspace root. The SDK-only check passed frozen reinstalls with a tarball at
either location in a full checkout. A pruned build that omits the root tarball fails with `ENOENT`.

For the SDK alone, root resolution and `pnpm --filter <package> add <Release URL>` both worked
in the small pnpm 11.8.0 check. A pnpm 11 workspace reported unrelated peer changes after a
filtered add and a missing integrity hash after root resolution. A frozen install with that
missing hash prints this error.

```text
[ERR_PNPM_MISSING_TARBALL_INTEGRITY] Cannot install package "@logbird/sdk@<Release URL>": its lockfile entry has no "integrity" field, so pnpm cannot verify the downloaded tarball.
```

Publishing to the npm registry would remove the need for either tarball recipe. It is planned and still pending.

## Usage

```ts
import { Hono } from 'hono';
import { Logbird, type LogbirdError } from '@logbird/sdk';
import { logbird, type AuditVariables } from '@logbird/hono';
const reportAudit = ({ code, status, count }: LogbirdError) => console.error('Logbird audit', { code, status, count });
const client = new Logbird({
  endpoint: process.env.LOGBIRD_ENDPOINT!,
  apiKey: process.env.LOGBIRD_INGEST_KEY!,
  onError: reportAudit,
});
const capture = logbird({ client, actor: c => ({ type: 'user', id: 'resolved-session-user' }), tenant: c => ({ id: 'resolved-session-tenant' }), autoTrack: {}, onError: reportAudit });
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
Failures omit only the failing field and report `capture_resolver_failed` through `onError`.
Log the error's `code` and any numeric `status` or `count`. `audit()` returns the event ID
immediately. Use `await c.var.audit.carrier({ parentEventId: eventId })` to propagate it into worker data.
Edge `waitUntil` drains pending context resolution before flushing. Both
`audit.pending()` and the edge wait include `audit.carrier()` resolvers. Carrier
resolution is host work outside the SDK's `maxQueueSize` limit. Node hosts
await `capture.shutdown()`, which includes pending capture resolution in the
same budget as queued and in-flight delivery. Handle a rejected shutdown promise as a
delivery failure. Blank event ids get a UUID. The id returned by `audit()`
is preserved in the event sent even when `beforeSend` returns a different id.
See the [SDK options and worker guide](../../sdk/README.md).
