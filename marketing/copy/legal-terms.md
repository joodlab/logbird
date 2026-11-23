---
title: Terms of service — Logbird
description: The terms for using the Logbird website and Logbird Cloud during early access. The open-source software stays under the MIT licence.
path: /legal/terms
---

Page text renders from `apps/web/src/content/legal-terms.ts` (the frame both legal pages share from `apps/web/src/content/legal.ts`); edit it there. This file is the brief: jobs, sources and owner notes.

# Terms of service

The page text lives in `apps/web/src/content/legal-terms.ts`, with the frame and the stand-in wording for unset
operator facts in `apps/web/src/content/legal.ts`; the facts themselves are constants and settings in
`apps/web/src/lib/legal-facts.tsx`. The text is owner-approved: change no word without the owner. The terms cover the
website and Logbird Cloud during early access. The open-source software is MIT-licensed and the terms say they don't
limit anything the licence allows.

## Owner facts (settings, not copy)

| Fact | Setting | Unset wording |
| --- | --- | --- |
| Operator name | `WEB_ORG_NAME` | "the operator of Logbird Cloud" |
| Postal address | `WEB_LEGAL_ADDRESS` | omitted |
| Governing law | `WEB_GOVERNING_LAW` (e.g. "the laws of <country>") | "the laws of the country where the operator is established" |
| Contact | `WEB_CONTACT_EMAIL` | the contact form |

## Owner to confirm

- Governing law and courts; the entity and its address.
- "Free during early access" and the `FEE_NOTICE_DAYS` (30) notice before fees (`apps/web/src/lib/legal-facts.tsx`).
- The liability wording: as-is during early access; total liability for all claims capped at the greater of fees
  paid in the 12 months before the claim and 100 euros; consumer rights preserved.
- Deletion within `CLOSURE_DELETION_DAYS` (30) days after the agreement ends, via the privacy contact.
- That a data processing agreement can be offered on request.
- A lawyer's review is recommended, not required to ship.

## Code facts behind the terms

- Early access with restricted sign-up: `AUTH_SIGNUP=restricted` (`packages/auth/src/signup-policy.ts`).
- No billing or plan code exists; site copy says pricing isn't set (`apps/web/src/content/pricing.ts`).
- Customers choose retention per project and can export events (CSV, JSONL) from the console
  (`apps/server/src/data-routes.ts`).
- Account deletion and complete workspace-data deletion are handled by request (#130). An owner-only
  organization-delete endpoint is reachable (`apps/server/src/route-authorization.matrix.ts`), but it removes Postgres
  records without purging ClickHouse (`docs/cloud-accounts-design.md`), so it isn't a complete deletion path.
- No SLA anywhere in code or copy; backups exist per the owner.
