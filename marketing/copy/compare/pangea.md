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
- **status note (shown as a callout titled "Ownership, as of 7 November 2026"):** As of 7 November 2026: CrowdStrike completed
  its acquisition of Pangea on 26 September 2025, and Pangea's product and signup pages redirect to CrowdStrike, while
  the Secure Audit Log documentation and API are still published. Check current availability with CrowdStrike. [P5–P7]
- **visual:** none

## table

- **id:** `table`
- **heading:** At a glance
- **data:** the "At a glance" table is rendered from `apps/web/src/content/comparisons.ts`, its only source.

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
  - You want **SQL-level questions** answered against your own ClickHouse, under limits you can read in the code. <!-- private build: "under documented limits" -->
- **cta:** Self-host it → `/self-hosting` · Join the waitlist → `/contact`
- **visual:** none

## sources

- **id:** `sources`
- **heading:** Sources
- **data:** the numbered sources are rendered from `apps/web/src/content/comparisons.ts`, its only source.
- **data:** what we couldn't verify is rendered from `apps/web/src/content/comparisons.ts`, its only source.
- **visual:** none
