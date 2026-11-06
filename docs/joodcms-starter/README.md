# StayDesk × Trailmark starter

A ready-to-apply starting point for [staydesk-integration.md](../staydesk-integration.md). **Nothing here has been
applied to StayDesk.** Applying it needs the owner's sign-off and a StayDesk PR that follows StayDesk's own rules
(topic branch, `pnpm fix --unsafe`, Commitizen, merge commit).

- `staydesk-trailmark-starter.patch`: `git apply` against StayDesk `master` (`0f712673a`, checked with
  `git apply --check`). 576 lines; three new files plus about 50 inserted lines in 11 existing files.
  `lib/audit/*.ts` compiles under `tsc --strict` (TypeScript 7.0.2) against the `@trailmark/sdk` /
  `@trailmark/hono` 0.2.0 sources from PR #43, with StayDesk imports stubbed to their real shapes. It has not yet been
  type-checked inside StayDesk, because installing StayDesk dependencies needs the owner's sign-off.
- The snippets below cover the parts that need StayDesk judgment (auth hooks, jobs, admin links, phase-2 history).

## Prerequisites

1. Trailmark roadmap **P0-1** merged and released as `@trailmark/sdk@0.2.0` / `@trailmark/hono@0.2.0`. The patch
   uses the lazy resolvers, `requestId` resolver, `enabled`, `defaults`, `beforeSend`, `redact`, `jobAudit` and
   `audit.carrier()`.
2. Decision **D1**: published packages (add them to `minimumReleaseAge` exclusions), or vendored copies under
   `packages/trailmark-*` with the dependency entries changed to `workspace:*`.
3. A Trailmark project per environment and keys (integration doc §4.4), stored as k8s secrets.

## What the patch does

| File | Change |
| --- | --- |
| `apps/server/src/lib/audit/client.ts` (new) | One `Trailmark` client per process (`enabled` only with `TRAILMARK_INGEST_KEY`); global Hono middleware with lazy actor/tenant resolvers (business tenant from validated context only, standalone website fallback, cached names), StayDesk `requestId`, trusted IP; typed `audit()` helper usable anywhere in a request (via `contextStorage`) that adds the impersonator from the session; `auditCarrier()` for job data; `auditJob()` for processors; `shutdownAudit()` |
| `apps/server/src/lib/audit/catalog.ts` (new) | Typed catalogue of wave 1 and wave 2 actions with default severity; `AuditAction` type |
| `apps/server/src/lib/audit/redaction.ts` (new) | `beforeSend` safety net: secrets everywhere, guest PII keys outside actor/impersonator, catalogue severity |
| `apps/server/src/env.ts` | Optional `TRAILMARK_ENDPOINT`, `TRAILMARK_ENVIRONMENT`, `TRAILMARK_INGEST_KEY`, `TRAILMARK_READ_KEY` |
| `apps/server/src/lib/hono/context.ts` | `HonoVariables` includes `AuditVariables` (`c.var.audit`) |
| `apps/server/src/server.ts` | Mounts the middleware after `enrichEvlogRequestLifecycle` |
| `apps/server/src/index.ts`, `apps/worker/src/index.ts`, `apps/server/src/worker-runtime.ts` | Flush on shutdown before `flushObservability()` |
| `apps/server/src/permissions/guard.ts` | `authorization.denied` next to the existing evlog denial |
| `apps/server/src/actions/impersonation.ts` | `admin.impersonation.started` / `.ended` |
| `apps/server/src/modules/admin/api-keys/handlers.ts` | `api_key.created`, `.permissions_updated`, `.regenerated`, `.revoked` |
| `apps/server/src/modules/app/business/modules/roles/handlers.ts` | `business.role.created` / `.updated`, dual-written next to evlog |
| `apps/server/package.json` | `@trailmark/hono`, `@trailmark/sdk` |

Apply and verify in StayDesk:

```sh
git switch -c feat/trailmark-audit origin/master
git apply staydesk-trailmark-starter.patch
pnpm install && pnpm fix --unsafe
pnpm --filter @staydesk/server typecheck && pnpm --filter @staydesk/server test
```

Without `TRAILMARK_INGEST_KEY` the client is a no-op, so the patch is safe to merge before any environment has keys.

## Auth events (packages/auth)

The shared auth package must not depend on the server. Inject an emitter and register an after-hook in both
`packages/auth/src/app/server.ts` and `admin/server.ts` (check `ctx.context.newSession` / `ctx.context.returned`
against StayDesk's better-auth version):

```ts
// packages/auth/src/audit-hook.ts
import { createAuthMiddleware } from 'better-auth/api';

type AuthAudit = (action: string, event: { actor?: { type: 'user'; id: string; email?: string }; outcome?: 'success' | 'failure' | 'denied'; targets?: { type: string; id: string }[]; metadata?: Record<string, unknown> }) => void;
let emit: AuthAudit | undefined;
export const setAuthAudit = (fn: AuthAudit) => { emit = fn; };

const ADMIN_ACTIONS: Record<string, string> = {
  '/admin/create-user': 'user.created', '/admin/set-role': 'user.role_changed', '/admin/update-user': 'user.updated',
  '/admin/ban-user': 'user.banned', '/admin/unban-user': 'user.unbanned', '/admin/remove-user': 'user.deleted',
  '/admin/set-user-password': 'user.password_set', '/admin/revoke-user-sessions': 'auth.session_revoked', '/admin/revoke-user-session': 'auth.session_revoked',
};

export const auditAuthEvents = createAuthMiddleware(async (ctx) => {
  const failed = ctx.context.returned instanceof Error;
  if (ctx.path === '/sign-in/email') {
    const session = ctx.context.newSession;
    emit?.(failed ? 'auth.sign_in_failed' : 'auth.signed_in', {
      actor: session ? { type: 'user', id: session.user.id, email: session.user.email } : undefined,
      outcome: failed ? 'failure' : 'success',
      // Never the password; the attempted email only as a hash if the owner wants failure grouping.
    });
  } else if (ctx.path === '/sign-out') {
    emit?.('auth.signed_out', {});
  } else if (ADMIN_ACTIONS[ctx.path] && !failed) {
    const userId = ctx.body?.userId;
    emit?.(ADMIN_ACTIONS[ctx.path], { targets: userId ? [{ type: 'user', id: userId }] : [], metadata: { role: ctx.body?.role } });
  }
});
// In both configs: hooks: { before: enforceUserManagementPolicy, after: auditAuthEvents }
```

In the server, after creating the client: `setAuthAudit((action, event) => audit(action as AuditAction, event))`.
The better-auth handlers run inside the Hono request, so `audit()` still gets requestId, IP and executor; the
explicit `actor` covers sign-in, where no session user exists yet.

## Jobs

```ts
// Enqueue (handler): carry correlation and the requesting actor into the job.
const requestedId = audit('crm.export.requested', { targets: [{ type: 'crm_export', id: exportRow.id }] });
await crmQueue.add('crm:export:generate', { exportId: exportRow.id, audit: await auditCarrier(requestedId) });

// Process (apps/server/src/bull/processors/crm-export.ts): one summary event per run.
const track = auditJob(job);
track('crm.export.generated', { metadata: { rows }, outcome: 'success', targets: [{ type: 'crm_export', id: job.data.exportId }] });
```

Scheduled jobs without a carrier are recorded with `actor.type = 'system'`. Sync jobs emit
`crm.sync.completed` / `catalog.sync.completed` with counts, never one event per synced row.

## Admin history links (phase 1, no Trailmark change)

Expose the console base URL and production project id to `apps/admin` as non-secret build variables, e.g.
`VITE_TRAILMARK_CONSOLE_URL` and `VITE_TRAILMARK_PROJECT_ID`, and add a "History" link on the website, business, hotel
and user detail views:

```ts
const historyUrl = (kind: 'records' | 'tenants' | 'actors', id: string) =>
  `${import.meta.env.VITE_TRAILMARK_CONSOLE_URL}/p/${import.meta.env.VITE_TRAILMARK_PROJECT_ID}/${kind}/${encodeURIComponent(id)}`;
// records use "<type>:<id>", e.g. historyUrl('records', `website:${website.id}`); tenants use the business id.
```

## Customer history route (phase 2, after roadmap P1-1)

```ts
// apps/server/src/modules/app/business/modules/history/handlers.ts (sketch)
.get('/', ...routes.list, validator('query', historyQuerySchema), async (ctx) => {
  const actor = getContextUserOrThrow();
  const { business } = await getBusinessContextOrThrow(actor.id);
  const { targetType, targetId, cursor } = ctx.req.valid('query');
  await assertTargetInBusinessScope(business.id, targetType, targetId, ctx.get('user')); // hotel/website scopes
  const page = await readAuditTrail(
    { endpoint: env.TRAILMARK_ENDPOINT!, readKey: env.TRAILMARK_READ_KEY! },
    { ...trailQuery({ tenant: business.id, target: { type: targetType, id: targetId }, cursor, limit: 50 }), from: retentionStart(), order: 'desc' },
  );
  return ctx.json({
    // Project the response: never ip, user agent, emails, impersonator or attributes; Acme staff become "Acme support".
    data: page.data.map((e) => ({
      action: e.action, changes: e.changes, id: e.id, outcome: e.outcome, targets: e.targets, timestamp: e.timestamp,
      actor: e.impersonator || (e.attributes['actor.role'] ?? 'USER') !== 'USER' ? { name: 'Acme support' } : { id: e.actor?.id, name: e.actor?.name },
    })),
    nextCursor: page.nextCursor,
  });
});
```

The UI is a sheet modelled on `BusinessReservationActivitySheet.vue`, with one i18n key per action
(`audit.actions.hotel.policy.updated`) and RTL-safe layout.

## Tests to add in StayDesk

- Catalogue coverage: every `AUDIT_ACTIONS` key appears in at least one `audit(` / `track(` call (grep test), so
  the catalogue cannot drift from the code.
- Wave-1 call sites: run handlers with a mock client and assert action, actor, tenant and targets; assert that no
  emitted event contains `jcms_sk_`, `tm_`, `password` or guest email values.
