# JoodCMS integration plan

Status: **proposal, 2026-11-05**. Nothing here has been applied to JoodCMS; every JoodCMS change needs the owner's
sign-off. Evidence paths are relative to the JoodCMS repository root (read-only study of `master` at `0f712673a`).
The Logbird-side work is tracked in [roadmap.md](roadmap.md); a ready-to-apply starter is in
[joodcms-starter/](joodcms-starter/README.md).

## 1. What JoodCMS is, as an audit source

| Fact | Evidence | Consequence for Logbird |
| --- | --- | --- |
| API is Hono 4 on long-running Node (`@hono/node-server`), graceful SIGTERM shutdown | `apps/server/package.json`, `apps/server/src/index.ts` (`cleanup()`) | `@logbird/sdk` + `@logbird/hono` fit; batched async delivery; flush in `cleanup()` |
| Production: API HPA 4–6 pods, 4 worker pods, k3s on Hetzner; envs `ha-staging`, `production`, per-PR previews | `k8s/values/production.yaml:26-27`, `k8s/README.md`, `.github/workflows/deploy.yml` | Per-pod SDK queues; many processes behind one egress IP (see roadmap P0-2) |
| Auth is **per route**, not global: `createRouteConfig({ guard: [isAuthenticated, …] })` | `apps/server/src/lib/hono/route-config.ts`, `apps/server/src/middlewares/guard/*` | A global middleware sees no user; actor/tenant must resolve lazily at `audit()` time (roadmap P0-1) |
| Hono `contextStorage()` is on; `requestId` is owned by evlog | `apps/server/src/server.ts:30,59-61` | `audit()` can be called from actions via `getContext()`; reuse JoodCMS's `requestId` for log correlation |
| ~596 mutating endpoints (295 POST, 151 PUT, 43 PATCH, 99 DELETE) + 2 better-auth catch-alls; ~80 BullMQ job types; 4 inbound webhooks | `apps/server/src/modules/**/handlers.ts`, `apps/worker/src/processors.ts`, `modules/public/webhooks/*` | Instrument in waves (§3); jobs and webhooks are system/integration actors |
| Admin (`apps/admin`, Jood staff) and app (`apps/app`, customers) are Vue 3 + Vite SPAs on Cloudflare Workers, TanStack Vue Query, Hono RPC, RTL-first i18n | `apps/admin/wrangler.jsonc`, `apps/*/src/services/api.ts`, `App.vue` `ConfigProvider dir` | Read keys stay in the API; UIs call JoodCMS endpoints that proxy the read API; JoodCMS renders its own (Arabic/English) sentences |
| Dependencies come from public npm only; `minimumReleaseAge` policy; Docker builds use `turbo prune` + `--frozen-lockfile` | `.npmrc` (empty), `pnpm-workspace.yaml`, `apps/server/Dockerfile` | Logbird packages must be published or vendored (owner decision D1) |

### Existing audit-like data

- **evlog `audit` fields** go to HyperDX, not a database. Today only two places use them: permission denials
  (`apps/server/src/permissions/guard.ts:135-146`, `requestLog.audit.deny`) and business role create/update
  (`apps/server/src/modules/app/business/modules/roles/handlers.ts:237-241,285-289`). evlog allows one `audit` per
  wide event, single target, no executor/impersonator, and it is coupled to log sampling and redaction.
- **`WhatsAppConsentAudit`** (`packages/database/prisma/schema.prisma:5356-5368`) is an append-only compliance record
  written at `…/integrations/modules/meta-whatsapp/handlers.ts:597` and `modules/public/webhooks/meta-whatsapp/handlers.ts:172`.
  It stays the system of record in JoodCMS; new consent changes are **dual-written** as `whatsapp.consent.changed`.
- `WebsiteArticleRevision.editedById`, `*.createdById`, `WebsiteDeletionRecord`, `Changelog*` (product release
  notes) are not audit logs.

**Nothing is migrated or backfilled** (product decision: history starts when capture starts). The only dual-writes are
the two evlog audit sites (kept during shadow, then removed from evlog) and WhatsApp consent.

## 2. Envelope mapping

| Logbird field | JoodCMS source | Rule |
| --- | --- | --- |
| `actor` (signed-in) | `c.get('user')` after `isAuthenticated` | `{ type: 'user', id: user.id, name: user.fullName ?? user.name, email: user.email, role: user.role }` — `role` is the platform role (`USER`, `SUPPORT`, `ADMIN`, `SUPER_ADMIN`; `packages/shared/src/constants/roles.ts`) and lands in `attributes['actor.role']` |
| `actor` (API key) | `c.get('apiKey')` (`middlewares/guard/has-api-key.ts:17-51`) | `{ type: 'api_key', id: apiKey.id, name: apiKey.name }` — never the key or its prefix |
| `actor` (webhook) | JoodBooking, Meta WhatsApp, Postmark inbound, DataForSEO | `{ type: 'integration', id: 'joodbooking' \| 'meta-whatsapp' \| 'postmark' \| 'dataforseo' }`, `source` = same id |
| `actor` (visitor) | `/api/website/*` contact, newsletter, review | `{ type: 'anonymous' }` with no id; only these three visitor actions are captured |
| `actor` (job) | job data carrier (§4.3) or none | Requesting user when a user triggered the job; otherwise `{ type: 'system', id: 'scheduler' }` |
| `impersonator` | `c.get('session').impersonatorId` (`lib/impersonation.ts:124-165`, `middlewares/guard/is-authenticated.ts:33`) | Actor stays the impersonated user; impersonator = `{ id, name }` of the Jood admin |
| `executor` | process | API: `{ type: 'api', id: 'joodcms-api', name: 'JoodCMS API' }`. Worker: `{ type: 'worker', id: 'joodcms-worker:<queue>', name: <job name>, jobId, attempt: attemptsMade + 1 }`. Webhook handlers: `{ type: 'webhook', id: 'joodcms-api' }` |
| `tenant` | `businessContext` / `website.businessId` (`helpers/business-context.ts:13-17`) | **Business** when one exists, else the **Website** (standalone, `Website.businessId` is nullable). `{ id, name, kind: 'business' \| 'website' }`. Platform-scope actions (users, feature-flag definitions, themes, usage tiers) have **no tenant** unless they act on a specific business/website |
| `targets[]` | handler | Primary record first, then its parents: always the `website` when website-scoped, the `hotel` for room/policy/facility changes, the `business` for business-level records. Type names are singular snake_case (`hotel_room`, `crm_campaign`) |
| `changes[]` | handler diff | Only for settings-like updates (§3.3); field names are JoodCMS model fields; values follow §3.4 |
| `context.requestId` | `c.get('requestId')` (evlog) | Same id as the `X-Request-Id` response header and HyperDX logs |
| `context.operationId` | `x-logbird-operation` header or new UUIDv7 | Carried into jobs |
| `context.ip` | `getClientIpFromHeaders` (`lib/ip/extract.ts:38-80`) | Trusted resolver only, never raw headers |
| `environment` | client `defaults` | `production`, `staging`, or `preview` |
| `description` | handler | English operator sentence ("Lina published hotel Sunrise"); in-app UIs do **not** display it (§5) |
| `metadata` | handler | Small, non-PII context: `websiteId`, `businessId`, counts, statuses, module keys |
| `schemaVersion` | constant | `joodcms.1` |

Action names: `<entity>[.<sub>].<verb-past-tense>`, lower snake segments, e.g. `hotel.policy.updated`. The existing evlog
names (`business.role.create`) become past tense (`business.role.created`).

## 3. Event catalogue

Waves set the instrumentation order. Wave 1 (security, access, destructive, PII exports) must ship before production
shadow, and wave 2 (publishing and content) before "on". The catalogue lives in JoodCMS as a typed constant (starter:
`audit-catalog.ts`) so typos fail typecheck. Endpoints are given as `METHOD path` under `/api`; handler files are in
`apps/server/src/modules/…`.

### 3.1 Wave 1 — identity, access, security (≈70 call sites)

| Action | Trigger (evidence) | Targets | Notes |
| --- | --- | --- | --- |
| `auth.signed_in` / `auth.sign_in_failed` | better-auth `/sign-in/email` (app + admin instances, `packages/auth/src/{app,admin}/server.ts`) | `user` | Use `hooks.after` on `/sign-in/email`; failure outcome `failure`, no password/OTP. Admin instance sign-in gate denials (`admin/server.ts:33-51`) → outcome `denied` |
| `auth.signed_out`, `auth.session_revoked` | sign-out; `DELETE /app/me/sessions/:sessionId` (`app/me/handlers.ts:342`) | `user`, `session` | Session id only, never token |
| `auth.password_changed`, `auth.password_reset_requested`, `auth.password_reset` | `me/handlers.ts:719,772`; better-auth emailOTP | `user` | |
| `auth.email_change_requested`, `auth.email_changed` | `me/handlers.ts:539,590,659` | `user` | `changes: [{ field: 'email', before: '[redacted]', after: '[redacted]' }]` (staff email is allowed as actor, not as a diff) |
| `admin.impersonation.started`, `admin.impersonation.ended` | `POST /admin/businesses/:businessId/members/:membershipId/impersonate` (`admin/businesses/handlers.ts:821-839`, `actions/impersonation.ts:36-93`); `POST /app/impersonate/exit` | `user` (impersonated), `business` | Severity `warning`. Actor = admin on start/end; during the session every event carries `impersonator` |
| `authorization.denied` | `permissions/guard.ts:135-146`, `middlewares/guard/has-business-permission.ts`, `is-admin.ts` | `website` / `business` | Outcome `denied`, `metadata.missing` = permission names. Replaces the evlog-only record |
| `user.created`, `user.updated`, `user.role_changed`, `user.banned`, `user.unbanned`, `user.deleted`, `user.password_set` | `admin/users/handlers.ts:146,202,254,296`; better-auth admin plugin endpoints intercepted by `enforceUserManagementPolicy` (`packages/auth/src/user-management.ts:37-82`) | `user` | `role_changed` carries `changes: role`; severity `notice` (`warning` for SUPER_ADMIN grants) |
| `api_key.created`, `api_key.permissions_updated`, `api_key.regenerated`, `api_key.revoked` | `admin/api-keys/handlers.ts:17,28,34,39` | `api_key`, `website` | `ApiKey` has no `createdBy` column (schema 1821-1840); the event is the only record of who issued it. Severity `warning` |
| `business.token.created` | `POST /app/business/settings/tokens/pms\|public` | `business_token`, `business` | Never the token |
| `business.member.invited`, `.updated`, `.removed`, `.invitation_resent`, `.invitation_revoked` | `app/business/modules/members/handlers.ts:327,338,390,440,451` | `business_membership`, `user`, `business` | `removed` also revokes staff rows and invites (390-439): one event with counts in metadata |
| `business.staff.*`, `website.staff.*`, `website.invite.*` (same verbs) | `business/modules/staff/handlers.ts:260-510`; `websites/modules/staff/handlers.ts:452,579`; `websites/modules/invites/handlers.ts:91-145` | `website_staff`, `user`, `website` | |
| `invitation.accepted` | `POST /public/invites/accept`, `POST /public/business-invites/accept` (`actions/invitations.ts:83-120`) | `invitation`, `user` | May create the user: emit `user.created` too, same operation |
| `business.role.created`, `.updated`, `.deleted`; `website.role.created`, `.updated`, `.permissions_updated`, `.deleted` | `business/modules/roles/handlers.ts:208,245,293`; `websites/modules/roles/handlers.ts:97,219,334,427` | `role` | `changes` = added/removed permission names (`metadata.granted`, `metadata.revoked`) |
| `business.created`, `.updated`, `.deleted`; `business.website.attached`, `.detached`; `business.member.added` (admin) | `admin/businesses/handlers.ts:305,378,486,523-769,737` | `business`, `website` | `deleted` severity `critical` |
| `business.module.enabled` / `.disabled`, `business.feature_flag.overridden`, `business.language.*`, `business.ai_key.set` / `.deleted` | `admin/businesses/handlers.ts:201-252,841,889` | `business` | AI key: `changes: [{ field: 'aiKey', before: '[redacted]', after: '[redacted]' }]` |
| `website.created`, `.updated`, `.status_changed`, `.deleted`, `.restored`, `.purged` | `admin/websites/modules/core/handlers.ts` | `website` | `status_changed` = PUBLIC/PRIVATE/MAINTENANCE (schema 398). `purged` severity `critical` |
| `website.domain.added`, `.updated`, `.removed`, `.redirect_toggled`, `.provider_changed` | `websites/modules/domains/handlers.ts`, admin domain routes | `domain`, `website` | External side effects (Vercel/Cloudflare): record `outcome` honestly |
| `feature_flag.*`, `module.*`, `platform_integration.key.*` (created/updated/deleted) | `admin/feature-flags`, `admin/modules`, `admin/platform-integrations` | `feature_flag` / `module` / `platform_integration` | Platform scope, no tenant |
| `usage_tier.assigned`, `usage_tier.default_set`, `usage_pricing.updated`, `smart_booking.funding.updated` | `admin/usage-tiers`, `admin/usage-pricing`, smart-booking `PUT /funding` | `website`, `usage_tier` | Billing-relevant; `changes` with amounts allowed |
| `admin.seed.run`, `admin.queue.job_retried` / `.removed`, `admin.cache.cleared` | `admin/dashboard POST /seed`, `/seed/:seeder`; `admin/operations/*` | `seeder` / `queue` | `admin.seed.run` severity `critical`, with `metadata.seeder` and `environment` |
| `crm.export.requested`, `crm.export.generated`, `crm.export.downloaded`, `crm.export.handed_off` | `POST …/crm/exports`, job `crm:export:generate`, `GET …/crm/exports/:exportId/download` (business handler 755, website 613), `PATCH …/exports/:id/handoff` | `crm_export`, `website` / `business` | Reads of PII are audited. Row count in metadata, never the file key |
| `hotel.exported`, `b2b_client.exported`, `b2b_client.invoice.exported`, `website.usage_invoice.exported`, `reservation.attachment.downloaded` | `GET /app/business/hotels/export` (450), `b2b-clients/export`, `admin/websites/:id/usage/invoice.pdf` (580) | the exported record | |
| `ads.audience.uploaded` | `POST …/ads/audiences/upload` | `ad_audience`, `website` | Sends guest PII to ad platforms: count only |

### 3.2 Wave 2 — publishing and content (≈150 call sites)

| Action | Trigger | Targets | Notes |
| --- | --- | --- | --- |
| `website.theme.published`, `website.theme.published_edited`, `website.theme.changed`, `website.theme.claimed`, `website.design.updated` | `websites/modules/themes/handlers.ts:418,540`, `design/` | `website_theme`, `website` | `metadata.version` from `WebsiteThemeData.version` (schema 1237-1252). Draft saves (`POST …/active/editor`, line 307) are **not** captured (autosave noise) unless the owner decides otherwise (D6) |
| `article.created`, `.updated`, `.status_changed`, `.deleted`, `.restored`, `.revision_restored`, `.revision_deleted`, `.translated` | `websites/modules/articles/handlers.ts` | `article`, `website` | `status_changed` carries DRAFT/PUBLISHED/SCHEDULED/ARCHIVED. Scheduled publish by job `article:publish` = system actor. Body/HTML never in `changes` (field name only) |
| `website.tag.*`, `website.faq.*`, `website.promotion.*`, `website.redirect.*` | `tags/`, `faqs/`, `promotions/`, `redirects/` | record, `website` | |
| `hotel.created`, `.imported`, `.updated`, `.published`, `.unpublished`, `.enabled`, `.disabled`, `.deleted`, `.reordered` | `business/modules/hotels/handlers.ts`, `websites/modules/hotels/handlers.ts` (`PUT /:hotelId/publish`) | `hotel`, `business` / `website` | `isPublished` (schema 2279, 2470) |
| `hotel.room.*`, `hotel.policy.*`, `hotel.facility.*`, `hotel.amenity.*`, `hotel.faq.*`, `hotel.review.approved` / `.rejected`, `hotel.translation.updated` | same files | sub-record, `hotel` | `hotel.policy.updated` with field diffs is the reference event (SPEC §3) |
| `city.*` | website and business city modules | `city` | |
| `media.asset.uploaded`, `.updated`, `.deleted`, `.bulk_deleted`, `.moved`; `media.folder.*` | `websites/modules/media/*`, `business/modules/assets/*` | `asset`, `website` / `business` | Bulk = one event with count and ≤64 targets |
| `website.seo.updated`, `website.robots.updated`, `website.ai_readiness.updated` | `seo/handlers.ts` | `website` | |
| `website.settings.updated`, `business.settings.updated`, `website.booking_rules.updated`, `website.contact_info.updated`, `website.translation_settings.updated`, `website.language.*` | `settings/`, `general-settings/`, `business/settings` | `website` / `business` | Field diffs |
| `integration.connected`, `.updated`, `.verified`, `.disconnected`; `whatsapp.signup.completed`, `whatsapp.phone.registered`, `whatsapp.disconnected` | `websites/modules/integrations/modules/core`, `meta-whatsapp/handlers.ts`, business `integrations`/`connections` | `integration`, `website` | Credentials always `[redacted]` |
| `whatsapp.consent.changed` | `meta-whatsapp/handlers.ts:597`, webhook `:172` | `whatsapp_consent`, `website` | Dual-write next to `WhatsAppConsentAudit`; phone never sent (consent id only) |
| `mobile.release_batch.created`, `mobile.app.updated`, `mobile.assets.generated`, `mobile.update.reported` | `admin/mobile`, `mobile/service` | `mobile_app`, `website` | Runner = `api_key` actor |

### 3.3 Wave 3 — commerce, CRM, ads (≈200 call sites, after "on")

`reservation.created`, `.updated`, `.confirmed`, `.cancelled`, `.no_show`, `.payment_recorded`, `.refund_issued`,
`.room_*`, `.service_*` (`business/modules/reservations/handlers.ts`; proxied to JoodBooking, so `source: 'joodbooking'`
and outcome from the upstream response); `crm.guest.updated`, `.merged`, `.tagged`; `crm.segment.*`;
`crm.campaign.created`, `.launched`, `.cancelled`, `.deleted`; `crm.campaign.sent` (one summary per send job);
`promo_code.*`; `marketer.transaction.created`, `.voided`; `marketer.profile.updated`; `ads.campaign.created`,
`.updated`, `.published`; `ads.account.connected`, `.disconnected`; `ads.wallet.topped_up`; `b2b_client.*`
(approve/deny/suspend); `contact_message.replied`; `review.moderated`; visitor `contact_message.received`,
`newsletter.subscribed`, `review.submitted` (anonymous actor, ids only).

**Jobs and webhooks:** one **summary event per job run**, never per row: `crm.sync.completed` / `.failed` (counts by
resource), `catalog.sync.completed` (hotel/room/review syncs), `translation.completed`, `ai_index.reconciled`,
`joodbooking.webhook.processed`. Retries appear as `attempt` 2, 3, … on the same executor and operation.

**Not captured:** GETs other than the exports above; read-only POSTs (`*/search`, `data-explorer/query`,
`segments/preview`, `campaigns/audience-summary`, `*/insights`, `languages/preview`, `admin/users/search`);
visitor analytics, AI chat and search; theme draft autosaves; health scans; cache revalidation.

### 3.4 Redaction and PII rules

1. **Never sent:** passwords, OTPs, session tokens, API key material (even prefixes), invitation tokens, OAuth
   access/refresh tokens, webhook secrets, AI provider keys, preview tokens, cookie or Authorization values. When one of
   these changes, send `{ field, before: '[redacted]', after: '[redacted]' }`.
2. **End-customer PII stays in JoodCMS.** Guests (`WebsiteGuest`, `BusinessGuest`: email, phone, names, birthDate,
   nationality, gender, notes), booking `customerEmail`, contact messages, newsletter subscribers, review authors and
   WhatsApp phone numbers are referenced **by id only**. Target names for guests are `"Guest <first 8 of id>"`. Diffs
   of these fields carry `[redacted]`. Why: Logbird retention is per project, not per data subject, so an erasure
   request in JoodCMS must not leave copies in the audit log.
3. **Staff identity is allowed:** JoodCMS users' id, name and email as actor/impersonator; IP and user agent in
   `context`. These are security records under the project's retention (owner decision D4).
4. **Content bodies** (article HTML, email templates, theme data) are never diffed: field name only.
5. **Size:** at most 64 targets and 50 changes per event; strings in `changes` are truncated to 256 characters by the
   JoodCMS helper.
6. **Safety net:** the SDK `beforeSend: redact({ keys: DEFAULT_SECRET_KEYS })` plus a JoodCMS key list (`email` under
   `metadata.guest`, `phone`, `normalizedPhone`, `birthDate`). Roadmap P1-2 adds the same rules server-side at ingest.

## 4. Integration architecture

```
apps/admin, apps/app (Vue SPA, Workers) ──► JoodCMS API (Hono/Node, 4–6 pods) ──► Logbird /v1/events (ingest key)
                                              │  c.var.audit(...) after commit         ▲
                                              │  history routes ── read key ───────────┘ (GET /v1/events)
                                              └─ BullMQ job data carries AuditCarrier ──► apps/worker (4 pods) ─► /v1/events
```

### 4.1 Capture

- `apps/server/src/lib/audit/` owns one `Logbird` client per process (`enabled` only when `LOGBIRD_INGEST_KEY`
  is set, so local dev and tests are no-ops), the Hono middleware mounted globally **after**
  `enrichEvlogRequestLifecycle` (`server.ts`), and a typed `audit(action, partial)` helper that reads
  `getContext().var.audit` so actions outside handlers can audit too.
- Resolvers read `user`, `session`, `apiKey`, `website`, `businessContext` lazily at call time (requires roadmap
  P0-1). Call `audit()` **after** the Prisma write/transaction resolves; on known failures emit `outcome: 'failure'`
  only for wave-1 actions; denials come from the guards.
- `@logbird/hono` `autoTrack` stays **off** in production (it would double every mutation). During shadow it may be
  enabled on staging as a coverage sentinel (`http.*` events show mutations without a catalogue event).
- `packages/auth` gets an optional `onAuditEvent` callback injected by the server, so the shared auth package does not
  depend on Logbird.

### 4.2 Batching and failure behaviour

- SDK defaults: batch 100, flush every 1 s, 5 retries with backoff, bounded queue 10,000 events per process,
  `dropPolicy: 'oldest'`, 256 KiB per event. JoodCMS sets `maxQueueSize: 20_000`.
- A request never waits for Logbird and never fails because of it. During a Logbird outage each pod buffers in
  memory; overflow increments `client.dropped` and calls `onDrop`, which JoodCMS forwards to evlog
  (`audit.dropped`, level warn) and an OTel counter so HyperDX can alert.
- Shutdown: `await audit.shutdown()` in `apps/server/src/index.ts` `cleanup()` before `flushObservability()`, and
  the same in `apps/worker`. k8s `terminationGracePeriodSeconds` must exceed the SDK's flush time (default 30 s is
  enough).
- **Loss window:** a pod killed without SIGTERM loses at most ~1 s of events. If the owner wants zero-loss for wave-1
  events, JoodCMS can write them to a BullMQ `audit` outbox on Dragonfly and let the worker ship them (decision D5).
- Logbird answers 503 `project_busy` during retention maintenance and 429 when over budget; the SDK retries both.

### 4.3 Jobs and webhooks

- When a request enqueues a job, the handler puts `await c.var.audit.carrier()` into the job data as `audit`
  (`{ operationId, requestId, parentEventId, actor, tenant }`).
- Workers wrap processing with `jobAudit({ client, job, carrier: job.data.audit, executor: { id: 'joodcms-worker:' + queue } })`
  and emit one summary event per run. Scheduled jobs without a carrier get `actor.type = 'system'`.
- Webhook handlers use the request middleware with an `integration` actor override.

### 4.4 Projects, keys and environments

| Logbird project | JoodCMS env | Retention | Keys |
| --- | --- | --- | --- |
| `joodcms-production` | `production` | decision D4 (proposal 365 days) | ingest `joodcms-api`, ingest `joodcms-worker`, read `joodcms-api-history` |
| `joodcms-staging` | `ha-staging` | 30 days | same three |
| `joodcms-preview` | every PR preview, `environment: 'preview'`, `metadata.preview` = PR number | 7 days | one ingest, one read |
| local dev | none by default (client disabled); developers may point at their own Logbird | — | — |

One workspace, "Jood", owns all projects; Jood engineers and support are invited as members (Member can search;
Owner/Admin manage keys). Keys live only in k8s secrets as `LOGBIRD_ENDPOINT`, `LOGBIRD_INGEST_KEY`,
`LOGBIRD_READ_KEY`; never in `apps/admin`, `apps/app` or theme bundles. Separate API and worker ingest keys allow
rotation without a full redeploy. Where Logbird runs (cloud vs the self-hosted build on the same k3s cluster) is
decision D2.

### 4.5 Reading history

**Phase 1, Jood staff (no Logbird change):** `apps/admin` detail pages get a "History" link that opens the
Logbird console at `/p/<projectId>/records/<type>:<id>` (records), `/tenants/<businessId>` or `/actors/<userId>`.
Staff already are Logbird workspace members; the console is the operator tool.

**Phase 2, customers in `apps/app`:** a History sheet modelled on `BusinessReservationActivitySheet.vue` (opened from
`BusinessBookingDetailView.vue:513-562`), first on hotel, website and role detail pages, behind a new permission
`audit:read`.

- JoodCMS API route, e.g. `GET /api/app/business/history?targetType=hotel&targetId=…&cursor=…`, guarded by
  `isAuthenticated` + `hasBusinessPermission('audit:read')`.
- The handler checks that the target belongs to the caller's business (and hotel/website scope:
  `BusinessMembershipHotelScope`, `BusinessMembershipWebsiteScope`), then calls `readAuditTrail` with a query it builds
  itself via `trailQuery({ tenant: businessId, target: { type, id } })`, `from = now − retention`. **The tenant term
  is always forced server-side; user input never becomes raw `q`.** Each cursor page rebuilds the same query.
- The response is projected before returning: drop `impersonator`, `context.ip`, `context.userAgent`, `actor.email`
  and attributes; map Jood staff actors (`actor.role` ≠ `USER`) to "Jood support". The UI renders localized sentences
  from `action` + `targets` + `changes` with `@joodcms/i18n` (RTL-safe), not Logbird's English `description`.
- Before customers see history, roadmap P1-1 (tenant-scoped read tokens) replaces the project-wide read key on this
  path so a JoodCMS bug cannot read another tenant's events.

### 4.6 Multi-tenant scoping

Tenant = business, so "everything that happened in Azure Hotels" is `tenant:<businessId>`. Website-scoped staff get
`tenant:<businessId> target:(<websiteId1> OR <websiteId2>)`; hotel-scoped members get `target:(<hotelId>…)`. JoodCMS ids
are globally unique cuids, so id-only target terms cannot collide across types. Standalone websites (no business) are
their own tenant; if one later joins a business, its earlier history stays under the website tenant (`target:<websiteId>`
still finds it).

## 5. What JoodCMS must change

1. **Dependency** on `@logbird/sdk` and `@logbird/hono` (published or vendored, D1); add to the
   `minimumReleaseAge` exclude list if published fresh.
2. **Env** (`apps/server/src/env.ts`, worker env): `LOGBIRD_ENDPOINT`, `LOGBIRD_INGEST_KEY`, `LOGBIRD_READ_KEY`
   (all optional; capture is disabled without the ingest key). k8s secrets per environment.
3. **New** `apps/server/src/lib/audit/{client,middleware,catalog,redaction}.ts` (starter kit).
4. **Mount** the middleware in `apps/server/src/server.ts` after `enrichEvlogRequestLifecycle`; **flush** in
   `apps/server/src/index.ts` `cleanup()` and in the worker shutdown.
5. **Guards:** `permissions/guard.ts`, `has-business-permission.ts`, `is-admin.ts` emit `authorization.denied`.
6. **Auth:** `packages/auth` app and admin configs add `hooks.after` for sign-in and admin-plugin endpoints and
   `databaseHooks.session` create/delete, calling the injected `onAuditEvent`.
7. **Impersonation:** `actions/impersonation.ts` start/end events.
8. **Handlers:** add `audit()` calls wave by wave (§3). Replace the two `logger.info({ audit })` calls in
   business roles after shadow.
9. **Jobs:** carry `AuditCarrier` in job data for user-triggered jobs (CRM export, campaign send, translations, syncs)
   and wrap processors with `jobAudit`.
10. **Webhooks:** integration actors on JoodBooking, Meta WhatsApp, Postmark and DataForSEO handlers.
11. **History (phase 2):** `audit:read` permission, history routes and the Vue sheet; i18n keys for each action.
12. **Tests:** a JoodCMS unit test that every catalogue action is emitted somewhere (grep-based) and a
    mock-client test per wave-1 call site.

No Prisma schema change and no data migration is required.

## 6. Rollout

| Stage | Scope | Exit criteria |
| --- | --- | --- |
| 0. Prerequisites | Logbird roadmap P0s merged; Logbird host deployed (D2); projects and keys created | Smoke `pnpm smoke:prod` passes on the target Logbird |
| 1. Local + preview | Starter merged behind missing keys (no-op); `joodcms-preview` key on previews | JoodCMS unit tests green; preview events visible; no request-latency change |
| 2. Staging (`ha-staging`) | Wave 1, then wave 2; `autoTrack` coverage sentinel on | 7 days: `client.dropped = 0`, no 429/503 storms, average conformance ≥ 90, every wave-1 route covered (sentinel `http.*` without a sibling catalogue event ≈ 0), p95 API latency unchanged (±1 ms) |
| 3. Production shadow | Waves 1–2 to `joodcms-production`; nobody depends on it; sentinel off | 14 days: drops 0, ingest p99 < 500 ms, daily volume and ClickHouse disk growth measured, counts match HyperDX `route_key` mutation counts within 1% for instrumented routes |
| 4. On | Jood staff use console links (phase 1); evlog audit dual-write removed; wave 3 begins | Owner sign-off; alerting on drops and ingest silence live |
| 5. Customer history | Phase 2 History sheet after roadmap P1-1/P1-2 | Security review of the history route; tenant-isolation tests |

Rollback at any stage: remove `LOGBIRD_INGEST_KEY` (the client becomes a no-op). Nothing in JoodCMS reads Logbird
until stage 5.

## 7. Gap analysis (Logbird)

| Need | Today | Gap | Roadmap |
| --- | --- | --- | --- |
| Actor/tenant resolved after per-route guards | Integrations resolve before `next()` (`packages/sdk/src/integration.ts`) | Every JoodCMS event would lack actor/tenant | **P0-1** |
| Host-owned request id, environment defaults, PII hook, no-op mode, job capture | Not available | Correlation with HyperDX, PII safety net, worker events | **P0-1** |
| Fleet behind one egress IP | 600 req/min per peer per route on `/v1` (`apps/server/src/rate-limit.ts`) | 10 processes × 1 flush/s saturate it | **P0-2** |
| Install from JoodCMS | Packages unpublished | npm publish or vendor | **D1** (no code until decided) |
| Read-API pagination and filters by target/tenant | `GET /v1/events` has cursor, `target:`, `tenant:`, any range | None for phase 1; long-range cost unmeasured | P1-3 |
| Tenant-isolated reads for customer UIs | Read keys are project-wide | A JoodCMS bug could over-read | P1-1 |
| PII redaction at ingest | Client-side only | No server safety net | P1-2 |
| Operator history from JoodCMS admin | Console record/tenant/actor pages exist | None (deep links) | — |
| Embeddable history | Headless Vue `AuditTimeline`, Nuxt proxy | Hono read proxy helper missing; JoodCMS renders its own RTL UI | P1-4 |
| SLOs and limits | Partly in deployment.md | No published ingest SLO, no ingest-silence signal | P1-5 |
| Per-tenant export | Console export with `q` (operators) | Not on the read API | P2 |
| Webhooks/streaming, alerting on actions | None | — | P2 |
| Schema hints per action | Conformance score only | No per-action expectations | P2 |
| SSO | Email OTP | Fine for Jood staff | P2 |
| Data-subject erasure | Retention only | Avoided by the §3.4 PII rule | P2 / D4 |
