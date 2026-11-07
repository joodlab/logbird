---
title: Logbird and Pangea Secure Audit Log compared
description: Pangea Secure Audit Log is a hosted, tamperproof audit log with Merkle-tree proofs. How it compares with Logbird, sourced and dated.
path: /compare/pangea
---

# Logbird and Pangea Secure Audit Log

## summary

- **id:** `summary`
- **eyebrow:** Compare
- **heading (H1):** Logbird and Pangea Secure Audit Log
- **body:** Pangea Secure Audit Log is a managed service built around tamper evidence. Every event goes into a Merkle
  tree. Pangea publishes the tree's root hashes to Arweave, a public, append-only ledger, and every search result can
  come with a proof that it hasn't been altered. Events can also be signed. Logs move through hot, warm and cold
  storage, and an embeddable React viewer lets your customers search and verify their logs. If you need to *prove*
  that logs weren't changed, that's what it was built for, and Logbird doesn't do it. [P1–P4]
- **status note (shown as a callout):** CrowdStrike acquired Pangea in September 2025. Pangea's product and signup
  pages now redirect to CrowdStrike, while the Secure Audit Log documentation and API are still published. Check
  current availability with CrowdStrike. [P5–P7]
- **visual:** none

## table

- **id:** `table`
- **heading:** At a glance
- **table:**

  | | Logbird | Pangea Secure Audit Log |
  | --- | --- | --- |
  | Licence and source | MIT | Hosted service, no source published; SDKs and the viewer component are MIT [P8, P9] |
  | Self-host | Yes: Docker Compose or Coolify | No self-host option documented; Pangea's Edge and Private Cloud models don't list the audit service [P10, P11] |
  | Hosting model | Self-hosted, MIT (source opens soon); Logbird Cloud waitlist | Hosted by Pangea [P12] |
  | Schema | Any JSON with an `action`; recommended envelope | Templates (for example Timestamp, Actor, Action, Status, Target, Source, Tenant ID, Old, New, Message) or a custom schema per configuration; the schema can't change after creation [P13] |
  | Tamper evidence | None | Merkle-tree tamperproofing, roots published to Arweave, optional event signing [P2] |
  | Search | Query language and guarded SQL `WHERE` mode | `field:value` with `AND`, `OR`, parentheses and quotes; up to 10,000 results per search [P14, P12] |
  | Retention | Per project, 7 days to 10 years; hourly permanent deletion | Hot up to 14 days, warm up to 10 years, cold up to 10 years (cold retrievable on request) [P15] |
  | Customer-facing viewer | None yet; read API plus headless Vue helpers | Embeddable React component, `@pangeacyber/react-mui-audit-log-viewer`, wired to your backend [P9] |
  | Storage engine | ClickHouse for events, Postgres for metadata | Not disclosed |
  | Pricing | Self-host free (MIT); Cloud pricing not set | Credit-based pay-as-you-go, with a $5 monthly credit per organization [P16] |

- **visual:** none

## choose-them

- **id:** `choose-pangea`
- **heading:** When to choose Pangea Secure Audit Log
- **bullets:**
  - You need **cryptographic proof** that audit events haven't been changed, with verifiable published roots.
  - You want **event signing** with managed or imported keys.
  - You want a **ready-made, embeddable viewer** that also verifies integrity.
  - You want **tiered storage** for very long retention and don't need to self-host.
- **visual:** none

## choose-us

- **id:** `choose-logbird`
- **heading:** When to choose Logbird
- **bullets:**
  - Your events must **stay on your own servers**, under an MIT licence.
  - You want to **send any shape** without designing a fixed schema first.
  - Your team investigates with an **operator console**: entity pages, operation trees, workers and retries, and SQL.
  - You want **SQL-level questions** answered against your own ClickHouse, under limits you can read in the code.
- **cta:** Self-host Logbird → `/self-hosting` · Join the waitlist → `/contact`
- **visual:** none

## sources

- **id:** `sources`
- **heading:** Sources (all accessed 2026-11-07)
- **list:**
  - P1 — About: "transparent, immutable, and cryptographically verifiable tamperproof audit logging".
    https://pangea.cloud/docs/audit/overview/about
  - P2 — Tamperproofing: Merkle trees, roots published to Arweave, membership and consistency proofs, signing.
    https://pangea.cloud/docs/audit/about-tamperproofing
  - P3 — Secure Audit Log docs home. https://pangea.cloud/docs/audit/
  - P4 — Settings: log signing, retention tiers. https://pangea.cloud/docs/audit/getting-started/settings
  - P5 — CrowdStrike press release, 16 Sep 2025: agreement to acquire Pangea.
    https://www.crowdstrike.com/en-us/press-releases/crowdstrike-to-acquire-pangea-to-secure-every-layer-of-enterprise-ai/
  - P6 — CrowdStrike FY2026 10-K: acquisition completed 26 Sep 2025.
    https://www.sec.gov/Archives/edgar/data/1535527/000153552726000010/crwd-20260131.htm
  - P7 — `pangea.cloud/services/secure-audit-log/` and `/signup/` return 301 redirects to
    https://www.crowdstrike.com/en-us/platform/falcon-aidr-ai-detection-and-response/ (checked by HTTP request).
  - P8 — SDK repositories (licence field: MIT). https://github.com/pangeacyber
  - P9 — React viewer docs and package. https://pangea.cloud/docs/libraries/react-mui-audit-log-viewer/ ·
    https://github.com/pangeacyber/pangea-javascript/tree/main/packages/react-mui-audit-log-viewer
  - P10 — Deployment models. https://pangea.cloud/docs/deployment-models/ · https://pangea.cloud/docs/deployment-models/edge
  - P11 — Private Cloud. https://pangea.cloud/docs/deployment-models/private-cloud
  - P12 — API reference: base URL, `/v2/log` (1–1000 events), search limits. https://pangea.cloud/docs/api/audit/
  - P13 — Configuration and schemas. https://pangea.cloud/docs/audit/getting-started/configuration
  - P14 — Searching the logs. https://pangea.cloud/docs/audit/using-secure-audit-log/searching-the-logs
  - P15 — Retention tiers (same page as P4); cold export.
    https://pangea.cloud/docs/audit/using-secure-audit-log/cold-export
  - P16 — Billing: credit-based, pay-as-you-go, $5 complimentary monthly balance.
    https://pangea.cloud/docs/admin-guide/organizations/billing/
- **unverified (left out of the table):** whether CrowdStrike still sells Secure Audit Log to new customers; per-unit
  prices (the public billing page doesn't render them; figures exist only in the page's script source); the signing
  and hash algorithms; the storage engine; whether `message` is required in the default template.
- **visual:** none
