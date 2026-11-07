# Logbird workspace activity

Workspace activity uses streams `ws:<organizationId>`, separate from project events. Existing history is preserved;
new evidence starts at deployment and does not backfill gaps.

## Durable delivery and atomicity

Run `pnpm db:deploy` before deploying the server. Additive migrations add the outbox/staging tables,
recovery/retention indexes, and nullable indexed `User.emailHash`. Existing records, keys and constraints remain
intact. Roll back application code while keeping these columns/tables; never drop pending evidence.

Owned Postgres mutations commit their frozen redacted outbox payload in the **same transaction**: project creation,
updates and retention policy/review, keys, saved views, invite links and joining through a link. An outbox INSERT
failure rolls back the mutation and returns `503 audit_storage_unavailable`. Project deletion first purges ClickHouse
idempotently, then revokes keys, records `api_key.revoked` / `project.deleted`, and deletes the project in one Postgres
transaction. If that transaction fails the project/keys remain; the already completed ClickHouse purge is not undone.

Workspace name/slug changes use owner/admin `PATCH /api/workspace`: `SELECT FOR UPDATE`, update and outbox INSERT in
one transaction. better-auth rejects name/slug changes on its organization-update endpoint. A slug-only change says
"Changed the workspace URL slug". No rename advisory lock or before-snapshot request state remains.

Explicit session ends write deterministic `auth:end:<sessionId>:<orgId>:<namespace>` intents **before** deletion,
with `confirmedAt = null`. Before-hook failure prevents deletion. The after-hook confirms the intent without changing
the payload or failing an already successful action. The API reconciles intents older than 60 seconds: a missing
Session confirms deletion; a still-present Session is retained in quarantine as `not_committed`. Expiry cleanup is
excluded. Non-secret revoked-session creation time, address and user-agent are separate from requester context.
A later explicit retry may refresh a proved-aborted, never-claimed intent with the new action/request before deletion.
Pending concurrent attempts return a retryable error; a stale after-hook cannot confirm another request's intent.
Confirmed payloads and all delivery retries remain frozen.
If an unconfirmed session has disappeared after its original expiry, reconciliation quarantines it as
`expired_session_intent`: implicit expiry cleanup is ambiguous and must never become an attributed user revocation.
`auth.signed_in` uses deterministic `auth:signin:?` ids; the short creation-to-after-hook crash/storage window remains
tracked in [#82](https://github.com/joodlab/logbird/issues/82), along with better-auth member/invitation/organization-creation
hooks. Those successful committed actions retain their successful response if enqueue fails, with a safe diagnostic.
ClickHouse sample-data changes also span separate stores; they do not have a distributed transaction with Postgres.

Every API replica independently runs preparation and delivery with `allSettled`. Short `FOR UPDATE SKIP LOCKED`
transactions claim at most two confirmed due rows and persist a 60-second lease. Local `ingest()` runs outside the
transaction/locks, with at most two concurrent deliveries. Startup and one-second sweeps recover due rows and expired
leases. Attempt predicates fence late claimants. Shutdown stops claiming and finishes tracked work before closing
clients; a killed process leaves durable rows/leases. Delivery is independently retried per destination, without FIFO.

The same frozen JSON/id is retried after `503 ingest_pending`. No ingest core is copied into the worker. PR #62 adds
immutable exact-retry arbitration to this local call path; until it lands, ambiguous retries retain existing at-least-once
ClickHouse/rollup semantics. `duplicate_id_conflict`, `invalid_event` and non-throwing rejections are never acknowledged
or rewritten. Per-stream batching is tracked in [#83](https://github.com/joodlab/logbird/issues/83). No WORM or constant-time
authentication claim is made.

## Failed sign-ins and budgets

Every failed OTP request stages a HMAC only, plus bounded request context, before returning. It does no membership
lookup, AES encryption/decryption or advisory locking. Existing windows increment directly; only new windows contend
on an atomic conditional admission-counter update. User hashes are backfilled in batches of 100 by the API and refreshed
on successful sign-in. The lookup waits while initial backfill is incomplete. Legacy encrypted windows are preserved
in quarantine (`legacy_identity_unresolved`) for explicit operator recovery, never guessed or silently dropped.

The anonymous actor is "Unverified sign-in"; a known member's user id and stored `name || email` are the target.
The attempted address, OTP and cookies are never event content. This stored-email display fallback is already known
to the workspace. Unknown identities have no workspace destination.

One initial failure and at most one counted summary are emitted per identity/reason/five-minute window. The first
uses `firstAttemptAt` and its original context. The summary uses `lastAttemptAt`, **no single requestId/IP/user-agent**,
and `metadata.firstAttemptAt`, `lastAttemptAt`, `distinctIps` (up to 10) and `ipsTruncated`. `lastContext` is kept in the
staging row for investigation, not misattributed to the whole burst. Occurrence times are frozen when stored; delayed
flush does not move them to delivery time. Reasons read "wrong code", "expired code" and "locked after too many wrong codes".

At most 600 fresh windows/hour receive the normal path. Above it, hash-only per-(hash,hour) overflow counters still
resolve members to counted workspace evidence; junk identities cannot blind all workspaces. The first overflow logs
`global_suppression_started`. Overflow counters may grow with fresh identities until the hourly retention boundary;
the cap bounds ordinary evidence production, not arbitrary hash cardinality. Each workspace admits 60 rows/hour plus
one counted suppression summary with `metadata.targets` (top 20 user ids/counts, plus a truncation flag). Summary
freezing waits for that hour's pending/quarantined windows to resolve, preventing late increments from being lost.
All window/budget/suppression identities include the namespace. Legacy round-2 budgets are retained/reported separately
in the transition hour. Authentication's separate peer/code limits are unchanged.

Email correlation uses `hashVersion: 1`, HMAC-SHA256 with key
`HMAC-SHA256(BETTER_AUTH_SECRET, "logbird/auth-audit/hash/v1")`, over trimmed lower-case canonical email. In a source
checkout, run `node --env-file=.env --import tsx scripts/auth-audit-hash.ts member@example.test`.
It prints `v1:<hex>`; compare **only the hex suffix** with `metadata.emailHash` or `User.emailHash`.
The runtime image has Node and does not include the source/tsx script. Its equivalent dependency-free command is:

```sh
node -e 'const c=require("node:crypto"),k=c.createHmac("sha256",process.env.BETTER_AUTH_SECRET).update("logbird/auth-audit/hash/v1").digest();console.log("v1:"+c.createHmac("sha256",k).update(process.argv[1].trim().toLowerCase()).digest("hex"))' member@example.test
```

Run it inside the server container with its existing environment; do not print the secret. Keep historical secrets
securely for historical correlation. A secret change requires a controlled user-hash backfill; this feature does not
rotate credentials or automatically erase old recovery evidence. The command uses Node built-ins; a new self-host
image/container execution was not part of the in-process proof.

## Retention, diagnostics and recovery

Each API replica runs batched sweeps (200 rows/table/minute), using short `SKIP LOCKED` deletes:
- delivered outbox rows: after 7 days;
- fully expanded closed windows (`flushedAttempts = attempts`): after window end + 1 hour;
- reported budgets: after window end + 24 hours, once no unresolved window from that hour remains.

Undelivered, unconfirmed and quarantined evidence is never automatically deleted. Retention limits duplicate personal
context in Postgres after delivery; workspace ClickHouse retention/purge is a separate policy. Quarantine is a deliberate
recovery exception: operators must investigate and explicitly dispose of unrecoverable evidence under their privacy policy.

`audit.delivery_failed` logs only `{id, stream, attempts, lastError}`. `audit.preparation_failed` similarly identifies
failed staging. While pending work exists, `audit.drain_lag {undelivered, oldestSeconds, quarantined}` is logged each
minute. `/readyz` exposes these numbers as non-failing `audit` details: a backlog does not make the dependency checks
fail. If details cannot be queried, `audit.unavailable` is true. Monitor age as well as counts.

Safe codes: `ingest_pending` means retry the exact payload; `duplicate_id_conflict` requires investigating the existing
identity (never mint a new id); `invalid_event` is a rejected event shape/type; `audit_rejected` covers other non-throwing
rejections; `audit_storage_unavailable` covers transient delivery/state failures. Delivery quarantines after 10 attempts.
Staging backs off per window and quarantines after 5 preparation failures; `legacy_identity_unresolved` quarantines
immediately, and `hash_backfill_pending` waits without consuming the quarantine budget. `not_committed` is a session
intent whose Session remained present during reconciliation. No error messages or credentials are persisted.

```sql
SELECT namespace, count(*) AS undelivered,
       extract(epoch FROM now()-min("createdAt")) AS "oldestSeconds",
       count(*) FILTER (WHERE "quarantinedAt" IS NOT NULL) AS quarantined
FROM "AuditOutbox" WHERE "deliveredAt" IS NULL GROUP BY namespace;
SELECT id, stream, attempts, "nextAttemptAt", "lastError", "confirmedAt", "sourceSessionId", "quarantinedAt"
FROM "AuditOutbox" WHERE "deliveredAt" IS NULL ORDER BY "createdAt" LIMIT 100;
SELECT id, "emailHash", "prepareAttempts", "lastError", "quarantinedAt", "windowEnd"
FROM "AuthAuditWindow" WHERE "closedAt" IS NULL ORDER BY "nextAttemptAt" LIMIT 100;
-- After fixing the cause and checking the exact namespace/id; keep attempt fences monotonic.
UPDATE "AuditOutbox" SET "quarantinedAt"=NULL, "nextAttemptAt"=now()
WHERE namespace='<namespace>' AND id='<reviewed-id>' AND "deliveredAt" IS NULL AND "confirmedAt" IS NOT NULL;
UPDATE "AuthAuditWindow" SET "quarantinedAt"=NULL, "nextAttemptAt"=now()
WHERE namespace='<namespace>' AND id='<recovered-hash-window>' AND "emailHash" IS NOT NULL;
```

A requeue grants a new attempt; another failure at the threshold quarantines again. Do not reset attempts (the lease
fence), edit frozen payloads, or blindly confirm `not_committed` intents. Recover legacy identities securely with the old
deployment secret/tooling, verify the canonical hash and original occurrence times against independent request logs,
then restore the hash/times and requeue the retained window. Migration defaults cannot establish historical attempt
times. If those times cannot be verified, leave the legacy window in quarantine; do not invent historical evidence.

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
| `export.requested`, `export.completed`, `export.failed` | export | user / project and export | linked export id, format/version, resolved query clock/range, rows/bytes; completion SHA-256; safe failure reason; see [exports](exports.md) |
| `auth.sign_in.suppressed` | auth | system / workspace stream | aggregate attempts and windowEnd |

Expired-session cleanup is skipped, including better-auth's `getSession` deletion of expired sessions. Direct database
deletes outside the HTTP auth lifecycle are outside coverage. Rename serialization spans the before-read, mutation
and durable insert only, with no nested ingestion-lock acquire. No-op/denied renames emit no success record. Recording
denied renames is deferred: authorization behavior remains unchanged and this PR does not introduce a new denied-action policy.

Canonical activity chips come from `WORKSPACE_ACTIVITY_CATEGORIES` in `@logbird/contracts`; Views maps to
`saved_view`, Workspace to `organization`, with separate Invite links and Sign-ins & sessions chips.
