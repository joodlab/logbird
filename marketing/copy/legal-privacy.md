---
title: Privacy policy — Logbird
description: What the Logbird website and Logbird Cloud collect, why, who processes it, how long it is kept and how to exercise your rights.
path: /legal/privacy
---

# Privacy policy

The page text lives in `apps/web/src/routes/legal.privacy.tsx`, which renders real text whether or not the operator
facts below are set. **Every statement must stay true to the code.** This file records where each one comes from;
re-check the source before you change a sentence, and update the effective date (`EFFECTIVE_DATE` in
`apps/web/src/lib/legal-facts.tsx`) with every substantive edit.

## Owner facts (settings, not copy)

| Fact | Setting | Unset wording |
| --- | --- | --- |
| Publisher / controller name | `WEB_ORG_NAME` | "The operator of Logbird Cloud" (release blocker) |
| Privacy mailbox | `WEB_PRIVACY_EMAIL` | the contact form's "A privacy request" topic (release blocker) |
| Postal address | `WEB_LEGAL_ADDRESS` | no address printed |
| Server provider and region | `WEB_HOSTING_PROVIDER` | "our server provider" |
| Team mailbox host (receives form submissions and emails) | `WEB_MAILBOX_PROVIDER` | "our mailbox provider" |
| Email delivery provider | `WEB_EMAIL_PROVIDER` | Postmark (Logbird Cloud's transactional provider, confirmed by the master 2026-11-10) |

The site stays noindex (robots `Disallow: /`) until the publisher name and the privacy mailbox are set
(`apps/web/src/lib/release.ts`). Without a privacy mailbox, rights requests go through the form's "A privacy
request" topic, stored like any submission and emailed to `WAITLIST_NOTIFY_TO`. That only works when the site's
`SMTP_*`, `MAIL_FROM` and `WAITLIST_NOTIFY_TO` are set (`apps/web/src/server/env.ts`): they are required on the
hosted site (docs/coolify.md). The Cloudflare build stores submissions in KV and sends no email; if the site ever
moves there, rewrite the form section first.

## Owner to confirm before relying on the text

- The legal entity, its country and address.
- The hosting provider and region of the Coolify server (`WEB_HOSTING_PROVIDER`, set at rollout). Transactional email
  is Postmark (server `logbird`; joodlab.com's own mailboxes on Zoho are unrelated). Keep Postmark's open and link
  tracking off: the policy says emails carry no tracking.
- Backups: provider, location, encryption and how long they're kept (the Cloud hero and the policy say backups exist;
  the policy says "stored with our server provider or a storage provider we choose").
- The team mailbox host (`WEB_MAILBOX_PROVIDER`) and the SMTP relay the site uses for form notifications (expected to
  mirror the console's Postmark settings).
- Closed accounts and workspaces deleted within `CLOSURE_DELETION_DAYS` (30) days of closing: a manual commitment.
- Keeping a closed account's entries in the activity of workspaces that still exist (the policy says so; nothing
  removes them today), rather than removing or anonymising them on request.
- The form retention period: `WEB_FORM_RETENTION_MONTHS` (default 24), shown as `FORM_RETENTION` ("24 months after
  our last exchange"). The site deletes its own copy of a submission that many months after it was sent (#132). The
  copies in the team mailbox and our emails are still a manual commitment.
- That the 30-day answer time for rights requests is workable.
- That production runs `AUTH_SIGNUP=restricted` (the terms say sign-ups are limited; the default is `open`).
- What access logs Cloudflare and the server provider keep, and for how long (the policy says they may keep them).
- That transfers rely on the providers' safeguards such as standard contractual clauses.
- A lawyer's review is recommended, not required to ship.

## Code facts behind each section

- **Website**: no cookies; theme in localStorage `logbird.site.theme` (`apps/web/src/routes/__root.tsx`). Fonts are
  self-hosted (`@fontsource`). The CSP allows only the site's own origin (`apps/web/src/lib/security-headers.ts`). The
  API's request log records method, path, status and duration (`apps/server/src/app.ts`); the site and console
  servers keep no request log of their own. HTTPS covers public connections only; internal hops (console → API,
  console → site, ClickHouse, Redis) are plain HTTP on the private network, so the policy says no more. `/docs` loads the Scalar bundle
  from jsDelivr (`apps/server/src/api-reference.ts`).
- **Form**: fields in `apps/web/src/lib/waitlist-schema.ts`; stored as JSONL with mode 600
  (`apps/web/src/server/waitlist-node.ts`, `/data` volume in `docker-compose.site.yml`); no IP or user agent stored;
  the rate limiter keeps IPs only in memory, each for a 60 s window, swept on later requests or at restart
  (`apps/web/src/server/waitlist.ts`); SMTP notification to `WAITLIST_NOTIFY_TO`. Retention: the Node server deletes
  submissions older than `WEB_FORM_RETENTION_MONTHS` within two days (at most about 30 hours late: a day file goes once
  its last moment has expired, and the cleanup runs ten minutes after start and every six hours): day files
  (`<WAITLIST_FILE>.d/YYYY-MM-DD.jsonl`) are deleted whole, the pre-day-file `WAITLIST_FILE` trimmed per record
  (`apps/web/src/server/waitlist-retention.ts`, `apps/web/waitlist/file.mjs`); the Cloudflare build sets the same
  lifetime as a KV expiry (`waitlist-cloudflare.ts`). One person's submissions are deleted on request with
  `node waitlist/admin.mjs forget <email>` (docs/coolify.md).
- **Accounts**: `User`, `Session` (ipAddress, userAgent), `Verification` in `packages/database/prisma/schema.prisma`;
  `emailHash` (`packages/auth/src/sign-in-audit.ts`); 6-digit hashed codes, 10 minutes, 3 attempts
  (`packages/auth/src/server.ts`); session cookie `__Secure-logbird.session_token`, 7 days, renewed daily
  (better-auth defaults); `sidebar_state` cookie (`packages/ui`). better-auth removes some expired rows as a side
  effect of sign-in traffic (looking up a session or a code); the worker's hourly sweep
  (`packages/database/src/auth-records.ts`, #129) is the backstop when that traffic stops: it deletes sessions on its
  first run after they've been expired for a day, codes after an hour and invitations (any status) 30 days after their
  `expiresAt`; a backlog or a failed run only moves that to a later run. Invitations also cascade with the workspace
  (`organizationId`) and with the inviter's account (`inviterId`). `Verification` rows aren't linked to an account and
  invitations belong to the inviting workspace, so neither is bounded by the invitee's account lifetime.
- **Workspace activity**: actor, IP and user agent on management, sign-in and failed sign-in records
  (`docs/workspace-audit.md`); readable by every member. Raw records end at the 3650-day ClickHouse TTL; the rollup
  tables (`002_rollups.sql`: names and attribute samples) and undelivered or quarantined Postgres outbox rows have no
  automatic limit (#131).
- **Customer data**: stored as sent (`packages/clickhouse/migrations/001_events.sql`); per-project retention
  7–3650 days, default 90 (`packages/contracts/src/api.ts`, `packages/database/prisma/schema.prisma`), permanent
  deletion verified (`packages/clickhouse/src/queries.ts`); project deletion
  purges events.
- **Rights**: no self-service account deletion or personal-data export (`apps/server/src/route-authorization.matrix.ts`,
  #130), so those are handled by request. Self-service today: display name (Account settings), project event export
  and project deletion (role permitting), session revoke endpoints (no UI).
- **No telemetry**: no analytics or tracking code anywhere; transactional emails have no pixels or tracked links
  (`packages/email`).

## form-line

The form shows, under its button: "We use these details to reply to you and handle access requests, and send product updates only if you choose
"Product updates only". No trackers. By sending, you confirm you've read the privacy policy." The topic list ends with "A privacy
request (access, deletion or another right)".
