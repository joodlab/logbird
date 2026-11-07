# Logbird workspace activity

Workspace activity uses streams `ws:<organizationId>`, separate from project events. Existing history is preserved;
new evidence starts at deployment and does not backfill gaps.

## Durable delivery

Run `pnpm db:deploy` before deploying the server. This adds `AuditOutbox`, `AuthAuditWindow` and
`AuthAuditBudget`; it changes no existing rows, keys or constraints. Older servers remain compatible. For rollback,
keep these tables and resume the new server later; do not drop pending evidence.

Each audit request freezes its event id, occurrence time, allowed fields and redacted JSON in Postgres before
returning. Every API replica runs a bounded outbox drainer. Short `FOR UPDATE SKIP LOCKED` transactions claim up to eight rows and persist a sixty-second lease; local `ingest()` runs after releasing those row locks and the transaction. Startup and one-second sweeps
rediscover due rows after process loss or an expired lease. Attempts, next-attempt time,
delivery time and a safe error code remain queryable in `AuditOutbox`. Shutdown stops new claims, drains in-flight deliveries, and waits for HTTP handlers before closing clients. Undelivered rows remain durable; a killed process leaves recoverable leases. No detached
post-response audit promises remain.

The same frozen JSON is retried with the same id, including after `503 ingest_pending`. The drainer calls the
server's local `ingest()` through a small delivery interface; no implementation is copied into the worker. PR #62
adds immutable ingest and exact-retry arbitration to that shared call path. Until #62 lands, ambiguous retries have
the existing at-least-once ClickHouse/rollup semantics; this PR does not independently replace its identity fence. A non-throwing rejection
(including `duplicate_id_conflict`) remains undelivered and is visible in `lastError`; it is never declared delivered
or rewritten under another id. Failed destinations cannot suppress healthy destinations. Operators should alert on
old undelivered rows and inspect safe codes, retaining source rows until reconciliation succeeds.

A Postgres outage after a mutation commits cannot be made atomic with better-auth's already committed operation.
The successful action keeps its response; `audit.storage_unavailable` / `auth.audit_storage_unavailable` reports that
exceptional evidence gap. ClickHouse outages after enqueue do not lose the durable record. No WORM or
constant-time authentication claim is made.

## Failed sign-ins and budgets

Failed OTP requests take the same membership-independent staging path before returning. Raw emails, codes and
cookies are never placed in event payloads. The lookup email is AES-256-GCM encrypted in the staging table using a
purpose-derived key, then erased after final fan-out. Membership lookup happens in the API drainer after the response. The anonymous actor
is "Unverified sign-in"; a known member's user id and display name are the target. Display names that contain an
email address are replaced with "Member". Unknown/pre-membership identities have no workspace destination.

There is one initial failure record and at most one counted summary per identity/reason/five-minute window. The
summary says how many further attempts occurred, with `metadata.attempts` and the window end. At most 600 fresh
identity/reason windows are admitted globally per hour; further attempts increment a single durable suppression
counter rather than creating identities or membership queries. Each workspace admits at most 60 failure rows per
hour plus one counted suppression summary. Authentication's separate peer/code limits remain unchanged.

Email correlation is HMAC-SHA256, `hashVersion: 1`, with key `HMAC-SHA256(BETTER_AUTH_SECRET,
"logbird/auth-audit/hash/v1")`. Normalize by trimming and lowercasing. An operator with the deployment secret can
run `node --env-file=.env --import tsx scripts/auth-audit-hash.ts member@example.test` and compare its printed
hash to `metadata.emailHash`. Keep the historical secret securely for investigating its historical hash version;
changing the secret breaks old correlation and decryption of pending staging identities. This feature does not rotate
or replace credentials.

## Activity action catalogue

Actor is the authenticated user unless otherwise stated. All records include frozen occurrence time and request/IP/
user-agent context where available. Keys and session tokens are never recorded. Category is the first action segment.

| Action | Category | Actor / targets | Changes or metadata |
| --- | --- | --- | --- |
| `project.created`, `project.deleted` | project | user / project | project id and display name |
| `project.updated` | project | user / project | name/description before → after |
| `project.retention.changed` | project | user / project | retentionDays before → after; sole row for retention-only updates |
| `project.retention.reviewed` | project | user / project | review occurrence |
| `project.setup.dismissed` | project | user / project | setupDismissed |
| `project.sample_data.loaded`, `project.sample_data.removed` | project | user / project | sample operation |
| `api_key.created`, `api_key.revoked` | api_key | user / key **and project** | kind, scope, safe prefix, state; `reason: project_deleted` for active keys revoked during deletion |
| `saved_view.created`, `saved_view.deleted` | saved_view | user / saved view | saved view display name |
| `organization.created` | organization | user / workspace | workspace display name |
| `organization.updated` | organization | user / workspace | actual name/slug before → after, plain old → new description |
| `member.invited` | member | user / invitation | invitation id/name |
| `member.invitation.accepted`, `.rejected`, `.canceled`, `.resent` | member | acting user / invitation | invitation id/name |
| `member.role.changed` | member | acting user / member | role before → after |
| `member.removed`, `member.joined_via_link` | member | acting user / member | member id/name |
| `invite_link.created`, `invite_link.revoked` | invite_link | user / invite link | link id and role, never its secret |
| `auth.signed_in` | auth | signed-in user / user | successful sign-in |
| `auth.signed_out`, `auth.session.revoked` | auth | acting user / non-secret session id | explicit sign-out/revoke routes only; repeated sign-out is a no-op |
| `auth.sign_in.failed` | auth | anonymous / targeted member user id | hashVersion, emailHash, reason, attempts, windowEnd, auditWindowSeconds |
| `auth.sign_in.suppressed` | auth | system / workspace stream | aggregate attempts and windowEnd |

Expired-session cleanup is skipped, including better-auth's `getSession` deletion of expired sessions. Direct database
deletes outside the HTTP auth lifecycle are outside coverage. Rename serialization spans the before-read, mutation
and durable insert only, with no nested ingestion-lock acquire. No-op/denied renames emit no success record. Recording
denied renames is deferred: authorization behavior remains unchanged and this PR does not introduce a new denied-action policy.

Canonical activity chips come from `WORKSPACE_ACTIVITY_CATEGORIES` in `@logbird/contracts`; Views maps to
`saved_view`, Workspace to `organization`, with separate Invite links and Sign-ins & sessions chips.
