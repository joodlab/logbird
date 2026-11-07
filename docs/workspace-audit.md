# Logbird workspace activity

Workspace activity stores management evidence separately from each project's incoming events. Existing records
are preserved; this update adds evidence for future operations and does not backfill historical gaps.

- Failed OTP sign-ins record `auth.sign_in.failed`, with an **unverified** anonymous actor and an HMAC-SHA256 email
  identifier (using the existing auth secret), IP, request ID, user agent and reason (`invalid_otp`, `expired_otp`,
  `locked_out`). Emails are trimmed/lowercased for attribution, and raw email addresses, OTPs and cookies are excluded
  from these records. A failed attempt is not attributed to the account holder as an authenticated actor.
  Existing members receive a record in each current workspace. Unknown users and users without memberships have no
  workspace stream; the same redacted application security log is emitted for every identity.
- Repeated failed attempts are audit-rate-limited across replicas/IPs: one record per email hash and reason every
  five minutes. Lockout is a separate reason, so the first lockout is retained even after invalid-code failures.
  Suppressed attempts are not counted or backfilled. Existing authentication throttles remain independent.
  Membership lookup and audit storage run after the auth response is returned, so their latency does not reveal
  workspace membership to a caller. Audit errors emit `auth.audit_failed` without changing the response/status. This path is best effort
  during storage failures; no durable outbox or crash replay is added. Responses do not reveal user/workspace lookup
  results, and do not claim constant-time authentication.
- Actual session deletion through better-auth records `auth.signed_out` for sign-out and `auth.session.revoked` for
  other hook-mediated session removal. The target is the non-secret session ID; tokens/cookies are excluded.
  No-op repeated sign-outs produce no second deletion record. Direct database deletion/TTL cleanup bypassing auth
  hooks is outside this coverage. Existing `auth.signed_in` records remain unchanged.
- Workspace name/slug changes produce `organization.updated` with actual before/after values and actor/request
  context. HTTP updates serialize on a separate organization-update advisory lock so concurrent rename receipts
  chain correctly without locking their own audit ingestion. No-op or denied updates emit no success record.
  Arbitrary metadata and logos are excluded from the audited field allowlist.
- All key creation paths (including the initial project ingest key) and key revocation preserve both API-key and
  project targets, read/ingest kind, `events:read`/`events:ingest` scope, safe display prefix and active/revoked state.
  No secret or key hash is copied. These facts remain in workspace activity after the project/key rows are deleted.
  Repeating revocation is idempotent and does not emit another lifecycle transition.
- Retention-only changes emit only `project.retention.changed`. A mixed update also emits `project.updated` for
  name/description changes, with disjoint before/after fields. No-op PATCHes emit neither change record.

Activity filter labels use the canonical categories in `WORKSPACE_ACTIVITY_CATEGORIES` (`@logbird/contracts`).
Views maps to `saved_view` and Workspace maps to `organization`. Workspace covers profile changes only; Invite links
and Sign-ins & sessions have separate chips. Projects, API keys and Members retain their existing categories.
No schema migration, credential change or self-hoster configuration is required.
