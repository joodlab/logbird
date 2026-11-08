# Logbird workspace activity

Workspace activity uses streams `ws:<organizationId>`, separate from project events. Existing history is preserved;
new evidence starts at deployment and does not backfill gaps.

## Durable delivery and atomicity

Run `pnpm db:deploy` before deploying the server. Additive migrations add the outbox/staging tables,
recovery/retention indexes, namespace/hour admission fences, window generations, and nullable indexed `User.emailHash`. Existing records, keys and constraints remain
intact. Roll back application code while keeping these columns/tables; never drop pending evidence.

Owned Postgres mutations commit their frozen redacted outbox payload in the **same transaction**: project creation,
updates and retention policy/review, keys, saved views, invite links and joining through a link. An outbox INSERT
failure rolls back the mutation and returns `503 audit_storage_unavailable`. Project deletion first purges ClickHouse
idempotently, then revokes keys, records `api_key.revoked` / `project.deleted`, and deletes the project in one Postgres
transaction. If that transaction fails the project/keys remain; the already completed ClickHouse purge is not undone.

Workspace name/slug changes use owner/admin `PATCH /api/workspace`: `SELECT FOR UPDATE`, update and outbox INSERT in
one transaction. better-auth rejects name/slug changes on its organization-update endpoint. A slug-only change says
"Changed the workspace URL slug". No rename advisory lock or before-snapshot request state remains.

Explicit session ends use self-only Logbird routes: `POST /api/session/sign-out`,
`POST /api/sessions/revoke` (`{sessionId}`; a non-secret id), `POST /api/sessions/revoke-all`, and
`POST /api/sessions/revoke-others`. They need an authenticated session, with no active-workspace/role requirement.
Each locks the selected live Session rows, deletes exactly those ids, and inserts frozen end evidence for each
workspace membership in **one Postgres transaction**. A concurrent sign-in outside that selection survives.
An insert failure/crash before commit rolls back both deletion and evidence; loss after commit leaves both durable.
Expiry cleanup is unaudited. Revoked-device creation/expiry/address/user-agent are distinct from requester context;
session tokens are never serialized. Sign-out and any revocation including the current session expire cookies using
better-auth's native helper (including chunked cache cookies). Repeated signed-out requests return 401; the console
handles an already-ended session as success. The four original better-auth HTTP endpoints return 409; API clients must
switch to these owned routes. Cookie-authenticated mutations require a trusted Origin or, when absent, a trusted Referer, using better-auth's own
origin middleware. Missing/bad sources, a null Origin and cross-site Fetch Metadata are rejected independently of CORS.
Sign-out errors keep the user signed in and show a retryable error toast. An already-ended sign-out clears stale cookies.

The former before/after-hook intents and reconciler are removed. The migration neutralizes up to 100 ambiguous
unconfirmed intents in quarantine as `legacy_session_intent`; a bounded per-minute sweep handles any remainder or
late writes from an older replica. It never guesses which action committed or refreshes its actor/payload. Deprecated
`confirmedAt`/`sourceSessionId` columns remain for rolling schema compatibility; new owned records use the default
confirmed state and no source intent. Delivered/confirmed historical evidence remains intact. Roll back code while
retaining the schema and quarantined rows, and investigate legacy intents against independent request evidence.
`auth.signed_in` uses deterministic `auth:signin:<sessionId>:<orgId>:<namespace>` ids; the short creation-to-after-hook crash/storage window remains
tracked in [#82](https://github.com/joodlab/logbird/issues/82), along with better-auth member/invitation/organization-creation
hooks. Those successful committed actions retain their successful response if enqueue fails, with a safe diagnostic.
ClickHouse sample-data changes also span separate stores; they do not have a distributed transaction with Postgres.

Every API replica independently runs preparation and delivery with `allSettled`. Short `FOR UPDATE SKIP LOCKED`
transactions claim at most two confirmed due rows and persist a 60-second lease. Local `ingest()` runs outside the
transaction/locks, with at most two concurrent deliveries. Startup and one-second sweeps recover due rows and expired
leases. Attempt predicates fence late claimants. Shutdown stops claiming and finishes tracked work before closing
clients; a killed process leaves durable rows/leases. Delivery is independently retried per destination, without FIFO.

If the destination workspace was deleted before delivery (including between its
existence check and the ingest receipt write), the row settles as moot with
`lastError=workspace_deleted` and a safe `audit.delivery_moot` diagnostic. Its
settled timestamp uses `deliveredAt` for the normal seven-day cleanup; this does
not assert delivery into a deleted workspace. Moot rows leave pending/quarantine
counts immediately, and other workspaces continue delivering. Existing raw
evidence is not removed by this handling.

The same frozen JSON/id is retried after `503 ingest_pending`. No ingest core is copied into the worker. PR #62 adds
immutable exact-retry arbitration to this local call path; until it lands, ambiguous retries retain existing at-least-once
ClickHouse/rollup semantics. `duplicate_id_conflict`, `invalid_event` and non-throwing rejections are never acknowledged
or rewritten. Per-stream batching is tracked in [#83](https://github.com/joodlab/logbird/issues/83). No WORM or constant-time
authentication claim is made.

## Failed sign-ins and budgets

Failed OTP requests attempt to stage a HMAC only, plus bounded request context, before returning. They never query
users or memberships. Every identity takes the same namespace/occurrence-hour admission row FOR SHARE before
touching windows; preparation shares that fence, then locks workspace budgets FOR UPDATE in sorted order before
window locks. Finalization takes the hour fence FOR UPDATE before its workspace budget and pending-window check.
A fresh uncommitted INSERT therefore cannot be invisible to a concurrent finalization, without membership-dependent
request round trips or workspace locks. This removes the audit-path account-existence timing signal; it does not
claim constant-time authentication or hide hash-specific contention.
No AES encryption/decryption or advisory lock is used. Fresh identities also contend on the short global
conditional admission-counter update. User hashes are backfilled in batches of 100 by the API and refreshed
on successful sign-in. The lookup waits while initial backfill is incomplete. Legacy encrypted windows are preserved
in quarantine (`legacy_identity_unresolved`) for explicit operator recovery, never guessed or silently dropped.

The anonymous actor is "Unverified sign-in"; a known member's user id and stored `name || email` are the target.
The attempted address, OTP and cookies are never event content. This stored-email display fallback is already known
to the workspace. Unknown identities have no workspace destination.

One initial failure and at most one counted summary are emitted per identity/reason/five-minute window. The first
uses `firstAttemptAt` and its original context, with both metadata times equal to that first attempt and only its IP. The summary uses `lastAttemptAt`, **no single requestId/IP/user-agent**,
and `metadata.firstAttemptAt`, `lastAttemptAt`, `distinctIps` (up to 10) and `ipsTruncated`. `lastContext` is kept in the
staging row for investigation, not misattributed to the whole burst. The summary IP set describes the full window, including the first attempt. Occurrence times are frozen when stored; delayed
flush does not move them to delivery time. Reasons read "wrong code", "expired code" and "locked after too many wrong codes".

At most 600 fresh windows/hour receive the normal path. Above it, hash-only per-(hash,reason,hour) overflow counters still
resolve members to counted workspace evidence; junk identities cannot blind all workspaces. The first overflow logs
`global_suppression_started`. Overflow retains the real `invalid_otp`, `expired_otp` or `locked_out` reason;
its sentence says "counted under the global admission limit" so the audit limit is not mistaken for the sign-in cause.
The older `global_overflow` reason is preserved only for legacy counters, where the original reason is unavailable.
Overflow counters may grow with fresh identities until the hourly retention boundary;
the cap bounds ordinary evidence production, not arbitrary hash cardinality. Each workspace admits 60 rows/hour plus
counted suppression summaries with `metadata.targets` (top 20 user delta counts, plus a truncation flag). Summary
freezing briefly waits for healthy, recently due windows from that hour. Quarantined, failed or over-60-second-stale
windows do not hold reports; late recovery produces a new suppression delta. A deferred budget moves its next attempt
60 seconds forward so 100 waiting rows cannot starve later pages.
A request encountering `closedAt` under the row lock advances only its generation suffix (`:g1`, `:g2`, …), preserving
the frozen attempt time and original five-minute/hour bucket. Normal and hourly overflow windows use the same policy.
Replica clock skew never moves an occurrence into another hour's budget. A closed summary is never reopened.
A finalized budget can receive a late expansion (for example after replica clock skew or membership/backfill changes).
`reportedSuppressed` and per-target watermarks advance atomically with an outbox INSERT, emitting only the new delta
under `auth-suppression-<budgetId>-<generation>`. Existing payloads/ids never change. `metadata.attempts` is that delta;
`totalAttempts` is the cumulative counter. Old reported counters and surviving legacy receipts initialize the watermarks.
A previously truncated legacy target list establishes a partial watermark: unknown user deltas are omitted with
`targetsTruncated: true`, while the overall delta count remains exact. Later watermarks use the full stored target map.
All window/budget/suppression identities include the namespace. Legacy round-2 budgets are retained/reported separately
in the transition hour. Authentication's separate peer/code limits are unchanged.

The populated reporting-migration proof is reproducible with
`pnpm --filter @logbird/server exec dotenv -e ../../.env -- vitest run src/audit-budget-migration.integration.test.ts`.
It runs the two committed migration UPDATE statements against transaction-local temporary tables, preserving all
public tables, and asserts legacy watermarks 5/5/25/0 and unreported deltas 2/2/4.

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
- fully reported, non-quarantined budgets (`reportedSuppressed = suppressed`): after window end + 24 hours, once no unresolved window from that hour remains.
- namespace/hour admission fences: after hour end + 24 hours, once no unresolved window from that hour remains; no identities or personal context are stored in these rows.

A separate bounded compatibility pass (100 rows/tick, indexed) closes completed round-2 windows only when their
identity was erased, `flushedAttempts = attempts > 0`, and `nextAttemptAt` is the round-2 year-9999 sentinel. It does not
reconstruct historical occurrence times. Those rows and their resolved budgets then follow normal retention.
Unresolved legacy rows remain retained for operator recovery.

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
immediately, and `hash_backfill_pending` waits without consuming the quarantine budget. `legacy_session_intent` means
an ambiguous pre-upgrade hook intent retained for investigation, never automatically confirmed.
Budget reporting retries independently with exponential backoff and quarantines after 5 preparation failures.
`audit.preparation_failed {kind: "budget", id, attempts, lastError}` uses `audit_budget_preparation_unavailable`
or `invalid_budget_watermark`; a poison budget cannot stop healthy budgets in the page. A state-write failure logs
`audit.preparation_state_unavailable`. No exception messages or credentials are persisted.

```sql
SELECT namespace, count(*) AS undelivered,
       extract(epoch FROM now()-min("createdAt")) AS "oldestSeconds",
       count(*) FILTER (WHERE "quarantinedAt" IS NOT NULL) AS quarantined
FROM "AuditOutbox" WHERE "deliveredAt" IS NULL GROUP BY namespace;
SELECT id, stream, attempts, "nextAttemptAt", "lastError", "confirmedAt", "sourceSessionId", "quarantinedAt"
FROM "AuditOutbox" WHERE "deliveredAt" IS NULL ORDER BY "createdAt" LIMIT 100;
SELECT id, "emailHash", "prepareAttempts", "lastError", "quarantinedAt", "windowEnd"
FROM "AuthAuditWindow" WHERE "closedAt" IS NULL ORDER BY "nextAttemptAt" LIMIT 100;
SELECT id, stream, suppressed, "reportedSuppressed", generation, "prepareAttempts", "nextAttemptAt", "lastError", "quarantinedAt"
FROM "AuthAuditBudget" WHERE NOT reported OR "quarantinedAt" IS NOT NULL ORDER BY "nextAttemptAt" LIMIT 100;
-- After fixing the cause and checking the exact namespace/id; keep attempt fences monotonic.
UPDATE "AuditOutbox" SET "quarantinedAt"=NULL, "nextAttemptAt"=now()
WHERE namespace='<namespace>' AND id='<reviewed-id>' AND "deliveredAt" IS NULL AND "confirmedAt" IS NOT NULL AND "sourceSessionId" IS NULL;
UPDATE "AuthAuditWindow" SET "quarantinedAt"=NULL, "nextAttemptAt"=now()
WHERE namespace='<namespace>' AND id='<recovered-hash-window>' AND "emailHash" IS NOT NULL AND "closedAt" IS NULL AND "flushedAttempts"<attempts;
UPDATE "AuthAuditBudget" SET "quarantinedAt"=NULL, "nextAttemptAt"=now()
WHERE namespace='<namespace>' AND id='<reviewed-budget-id>' AND NOT reported;
```

A requeue grants a new attempt; another failure at the threshold quarantines again. Do not reset attempts (the lease
fence), change generation/reporting watermarks without verified history, edit frozen payloads, clear `closedAt`, or confirm legacy session intents from a Session existence check.
A pre-upgrade closed window with `flushedAttempts < attempts` is retained but cannot be requeued: its summary id is
already frozen. Recover only the unreported delta into a **new generation/id**, verifying its hash, counts and first/last
times against independent request logs, then mark the old source resolved in the same operator transaction. Do not
reuse the closed summary id or infer the delta's occurrence times from the full window. Recover legacy identities securely with the old
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
| `api_key.created`, `api_key.revoked` | api_key | user / key **and project** | kind, scope, safe prefix, state; `reason: project_deleted` for active keys revoked during deletion; a rolled key is `api_key.created` with `reason: rotation`, `replaces {id, prefix}` and the replaced key as an extra target (the old key stays valid until its own `api_key.revoked`) |
| `saved_view.created`, `saved_view.deleted` | saved_view | user / saved view | saved view display name |
| `organization.created` | organization | user / workspace | workspace display name |
| `organization.updated` | organization | user / workspace | actual name/slug before → after, plain old → new description |
| `member.invited` | member | user / invitation | invitation id/name |
| `member.invitation.accepted`, `.rejected`, `.canceled`, `.resent` | member | acting user / invitation | invitation id/name |
| `member.role.changed` | member | acting user / member | role before → after |
| `member.removed`, `member.joined_via_link` | member | acting user / member | member id/name |
| `invite_link.created`, `invite_link.revoked` | invite_link | user / invite link | link id and role, never its secret |
| `auth.signed_in` | auth | signed-in user / user | `metadata.session {createdAt, expiresAt, ipAddress, userAgent}`; deterministic sign-in id |
| `auth.signed_out`, `auth.session.revoked` | auth | acting user / non-secret session id | `metadata.session {createdAt, expiresAt, ipAddress, userAgent}` describes the ended device; requester context is separate; explicit device/address sentence; replay after sign-out returns 401 and expires stale cookies |
| `auth.sign_in.failed` | auth | anonymous / targeted member user id | `hashVersion`, `emailHash`, `reason` (`invalid_otp`, `expired_otp`, `locked_out`; legacy `global_overflow` means original reason unavailable), `overflow`, `attempts`, `windowEnd`, `firstAttemptAt`, `lastAttemptAt`, `distinctIps`, `ipsTruncated`; first record snapshots its first attempt, summary describes the window |
| `auth.sign_in.suppressed` | auth | system / workspace stream | delta `attempts`, cumulative `totalAttempts`, `generation`, `windowEnd`, top-20 delta `targets [{userId, attempts}]`, `targetsTruncated`; no single requester context |

Expired-session cleanup is skipped, including better-auth's `getSession` deletion of expired sessions. Direct database
deletes outside the HTTP auth lifecycle are outside coverage. Rename locks the workspace row, reads/updates it and
inserts its frozen evidence in one Postgres transaction. No-op/denied renames emit no success record. Recording
denied renames is deferred: authorization behavior remains unchanged and this PR does not introduce a new denied-action policy.

Canonical activity chips come from `WORKSPACE_ACTIVITY_CATEGORIES` in `@logbird/contracts`; Views maps to
`saved_view`, Workspace to `organization`, with separate Invite links and Sign-ins & sessions chips.
