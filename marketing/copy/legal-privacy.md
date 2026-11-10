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
| Email delivery provider | `WEB_EMAIL_PROVIDER` | "our email delivery provider" |

The site stays noindex (robots `Disallow: /`) until the publisher name and the privacy mailbox are set
(`apps/web/src/lib/release.ts`). Without a privacy mailbox, rights requests still work: the form's "A privacy
request" topic is stored like any submission and forwarded to `WAITLIST_NOTIFY_TO`.

## Owner to confirm before relying on the text

- The legal entity, its country and address.
- The hosting provider and region of the Coolify server, and the email provider (DNS shows mail on Zoho; Postmark is
  the decided transactional provider in `docs/decisions.md` but isn't visible in DNS yet). If the provider has
  open/link tracking options, keep them off: the policy says emails carry no tracking.
- Backups: provider, location, encryption and how long they're kept (the Cloud hero and the policy say backups exist).
- The form retention period: `FORM_RETENTION` ("24 months after our last exchange"). Nothing deletes submissions
  automatically, so this is a manual commitment (a calendar reminder, or a cleanup job later).
- That the 30-day answer time for rights requests is workable.
- That transfers rely on the providers' safeguards such as standard contractual clauses.
- A lawyer's review is recommended, not required to ship.

## Code facts behind each section

- **Website**: no cookies; theme in localStorage `logbird.site.theme` (`apps/web/src/routes/__root.tsx`). Fonts are
  self-hosted (`@fontsource`). The CSP allows only the site's own origin (`apps/web/src/lib/security-headers.ts`). API
  request logs record method, path, status and duration (`apps/server/src/app.ts`). `/docs` loads the Scalar bundle
  from jsDelivr (`apps/server/src/api-reference.ts`).
- **Form**: fields in `apps/web/src/lib/waitlist-schema.ts`; stored as JSONL with mode 600
  (`apps/web/src/server/waitlist-node.ts`, `/data` volume in `docker-compose.site.yml`); no IP or user agent stored;
  rate limit keeps IPs in memory for 60 s (`apps/web/src/server/waitlist.ts`); SMTP notification to
  `WAITLIST_NOTIFY_TO`.
- **Accounts**: `User`, `Session` (ipAddress, userAgent), `Verification` in `packages/database/prisma/schema.prisma`;
  `emailHash` (`packages/auth/src/sign-in-audit.ts`); 6-digit hashed codes, 10 minutes, 3 attempts
  (`packages/auth/src/server.ts`); session cookie `__Secure-logbird.session_token`, 7 days, renewed daily
  (better-auth defaults); `sidebar_state` cookie (`packages/ui`). Expired sessions and codes are not purged.
- **Workspace activity**: actor, IP and user agent on management, sign-in and failed sign-in records
  (`docs/workspace-audit.md`); readable by every member; kept up to the 3650-day ClickHouse TTL.
- **Customer data**: stored as sent (`packages/clickhouse/migrations/001_events.sql`); per-project retention
  7–3650 days, default 90, permanent deletion verified (`packages/clickhouse/src/queries.ts`); project deletion
  purges events.
- **Rights**: no self-service account deletion or export (`apps/server/src/route-authorization.matrix.ts`), so
  requests are handled manually; display name is editable in Account settings.
- **No telemetry**: no analytics or tracking code anywhere; transactional emails have no pixels or tracked links
  (`packages/email`).

## form-line

The form shows, under its button: "We use these details to reply to you, and send product updates only if you choose
them. No trackers. By sending, you confirm you've read the privacy policy." The topic list ends with "A privacy
request (access, correction or deletion)".
