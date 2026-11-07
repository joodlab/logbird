# Cloud account lifecycle proposal

Status: design, 2026-11-07. These endpoints and jobs are proposed, not shipped.
Existing event contracts and capture/retention product decisions stay unchanged.

## Workspace deletion

The installed organization plugin can delete the Postgres organization and cascade
its projects. It does not know about ClickHouse. Logbird must prevent that path
from bypassing event deletion. A successful Postgres cascade alone is insufficient.

Use a durable Postgres deletion request, independent of the organization's foreign
key, and a retryable BullMQ job. Owner authorization and typed slug confirmation
are required. Store only request id, organization id, requester id, state, times,
lease/heartbeat and a safe error code. Do not retain event payloads or email addresses
in the receipt. Keep failed requests visible and retryable; never report completion
while any ClickHouse table still holds workspace data.

Proposed contract, implemented together in `packages/contracts` and the server:

| Route | Authorization | Result |
| --- | --- | --- |
| `POST /api/workspace/deletion` `{ confirm: slug }` | Current owner of the active workspace | `202 { id, status, requestedAt, completedAt, error }` |
| `GET /api/workspace/deletion` | Current owner, including while deletion is pending | Same status envelope, `404` if no request |
| Existing `/api/auth/organization/delete` | Intercept before the plugin | Reject with `409 workspace_deletion_required`; direct cascading deletion cannot run |

State transitions: `pending -> running -> completed`, with `running -> failed ->
pending` for explicit retries. Enqueue after recording the request. If enqueue
fails, return a retryable error and preserve the pending request. Worker startup
and scheduled reconciliation must re-enqueue pending requests and expired leases;
Redis alone must not be the request ledger. Duplicate submissions return the same
unfinished request. Only one worker may claim a request at a time.

After the request is durably pending, block new projects, key creation, ingestion,
sample writes and workspace audit writes, including organization-plugin mutations.
Reject reads consistently while a partial purge is in progress. The authorization
gate must check current persisted state, including inside each ingestion/project
lock, rather than relying on an earlier HTTP check. A worker takes the workspace
lifecycle lock before claiming the request; project creation and deletion enqueue
must use that same workspace lock to close the create/purge race.

For each project: take its existing exclusive project lock, drain accepted writes,
purge `events`, `events_by_minute`, `entities` and `attribute_keys`, verify zero rows,
then delete the Postgres project. Reuse the same purge routine as project deletion.
Do not hold a Prisma transaction or application connection across ClickHouse I/O.
Purge `ws:<organization id>` under its project lock too, without emitting another
workspace event afterwards. Finally delete the organization, clear affected active
sessions and mark the independent deletion receipt completed. A crash after the
purge but before Postgres deletion must be safe to retry; a partial ClickHouse purge
must preserve the request and prevent false completion.

Required proof against isolated fictional data: owner/admin/member/outsider
permissions; duplicate requests; enqueue failure and recovery; worker restart;
purge failure after the first table; create/ingest races; stale sessions; all four
tables empty for every deleted project and workspace stream; neighboring workspace
unchanged. An audit of existing orphaned project ids is counts-only until the
operator explicitly authorizes their deletion.

## Account deletion

Tracked implementation: [issue #49](https://github.com/joodlab/logbird/issues/49).

Account deletion is currently disabled. Keep the dependency's direct delete-user
and callback paths disabled until this flow is implemented. Account deletion must
not silently delete workspaces or their business audit history.

Propose `POST /api/account/deletion` with a fresh OTP challenge and confirmation of
the account email, plus `GET /api/account/deletion` for its status. The contract
returns the same asynchronous state/timestamp/error fields as workspace deletion.
Require ownership transfer or completed workspace deletion for every workspace
where the user is the last owner. Other memberships can be removed. Revoke only
this account's sessions, remove auth/verification records and user profile data,
and preserve workspace event records under the existing project retention policy.
Return an explicit list of blockers before accepting the deletion request.

This is account lifecycle functionality, not actor/target event erasure. A separate
data-subject request must identify the relevant workspace controller, authorized
project scope, raw payload and aggregate handling, external archives, and backup
expiry. Do not infer that deleting a user profile removes their events. Document
deletion receipts and backup expiry in the operator runbook; restored backups must
reapply deletion tombstones before traffic resumes.

## Workspace export

Tracked implementation: [issue #50](https://github.com/joodlab/logbird/issues/50).

Existing project exports do not constitute a complete workspace export. Propose:

| Route | Authorization | Result |
| --- | --- | --- |
| `POST /api/workspace/exports` | Owner/admin of active workspace | `202 { id, status, createdAt, expiresAt, error }` |
| `GET /api/workspace/exports/:id` | Recheck current workspace owner/admin membership | Status and authenticated download availability |
| `GET /api/workspace/exports/:id/download` | Same current membership check | Stream archive; no public permanent URL |
| `DELETE /api/workspace/exports/:id` | Same current membership check | Delete artifact, return `204` |

Archive a versioned manifest, workspace/project settings, saved views, membership
metadata appropriate to the requesting role, project event JSONL, and workspace
activity JSONL. Never export API-key hashes/secrets, session/OTP/auth tokens or SMTP
configuration. Apply bounded concurrency, query/runtime/byte budgets and short
artifact expiry. Encrypt temporary storage and remove it on success expiry,
cancellation, workspace deletion and failed jobs. Record the export's cutoff and
pagination semantics: today's read API is not a transactional snapshot, and export
may overlap retention. A queued export must recheck authorization at execution and
download, including after membership removal.

Required proof: two-workspace isolation; permission loss before execution/download;
redaction of credentials; partial-job cleanup; export cancellation; expiry; large
stream memory bound; retention overlap and truthful manifest counts. The UI needs
an explicit status/error/retry flow, not an immediate success toast on enqueue.

## Sign-up protection

Current protections: hashed OTP storage, a ten-minute OTP expiry, dependency-level
attempt counting, and a shared Redis per-peer auth request limit. Better-auth's own
limiter is disabled because the API uses Redis. Missing controls: per-email send
budgets, configurable disposable-domain rejection for new accounts and a server
verified CAPTCHA hook. Add shared limits across replicas with hashed identifiers;
the mailer must not run after a denial. Existing accounts must remain able to sign
in when a domain is later blocked. Preserve generic responses where needed to
avoid account enumeration. CAPTCHA failure/unavailability must not be accepted as
success when protection is enabled. Keep local Mailpit fixtures usable with the
feature disabled; no live challenge-provider account or payment is required here.

## UI handoff specification

Claude-owned UI work follows backend contracts. Workspace Settings gets an
owner-only deletion section with a permanent-deletion explanation, typed slug,
pending/running/failed status, safe retry and a completed destination outside the
deleted workspace. Account Settings lists last-owner blockers and links to transfer
ownership. Workspace Export lists jobs, expiry, cancel/retry and authenticated
download; it reports partial/failure states clearly. Controls require keyboard and
screen-reader labels, at least 44px touch targets, English copy, and mobile
verification at 390px. No visual implementation is part of this proposal.
