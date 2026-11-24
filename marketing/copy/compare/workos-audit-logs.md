---
title: Logbird and WorkOS Audit Logs compared
description: WorkOS Audit Logs is a hosted audit log API with an Admin Portal viewer and SIEM log streams. How it compares with Logbird, sourced.
path: /compare/workos-audit-logs
---

Page text renders from `apps/web/src/content/comparisons.ts` (the facts and sources) and `apps/web/src/content/compare.ts` (the page furniture); edit it there. This file is the brief: jobs, sources and owner notes.

# Logbird and WorkOS Audit Logs

## summary

- **id:** `summary`
- **eyebrow:** Compare
- **heading (H1):** Logbird and WorkOS Audit Logs
- **body:** WorkOS Audit Logs is a hosted service for recording what users do in your product and handing that record
  to your enterprise customers. You define a schema for each action, send events to the WorkOS API, and your
  customers' IT admins can view and export them through the WorkOS Admin Portal. Events can also stream to Datadog,
  Splunk, S3, Google Cloud Storage, Microsoft Sentinel, Snowflake or any HTTPS endpoint. If your customers' IT
  teams expect to browse and export audit logs themselves, it covers that out of the box. [W1–W5]
- **visual:** none

## table

- **id:** `table`
- **heading:** At a glance
- **data:** the "At a glance" table is rendered from `apps/web/src/content/comparisons.ts`, its only source.
- **Streaming to SIEM (Logbird cell):** "No built-in SIEM connectors; signed webhooks to public HTTPS endpoints". The job:
  don't overstate (Logbird has no SIEM connector), and don't understate (a SIEM's HTTPS intake can receive Logbird's
  signed webhooks). Held with the 0.3.0 webhook delivery: merges only after 0.3.0 is deployed and checked in production.
  The "log streams to a SIEM … now" bullet under choose-them stays.
  <!-- source: docs/SPEC.md § Webhook endpoint management (HTTPS endpoints with public addresses; Standard Webhooks signatures) -->

- **visual:** none

## choose-them

- **id:** `choose-workos`
- **heading:** When to choose WorkOS Audit Logs
- **bullets:**
  - Your enterprise customers' **IT admins need to view and export their own audit logs** today, through a ready-made
    portal.
  - You need **log streams to a SIEM** (Datadog, Splunk, Sentinel, S3 and others) now.
  - You want **strongly typed events**, validated against a schema for each action.
  - You'd rather **not run any infrastructure**, and you already use WorkOS for other features.
- **visual:** none

## choose-us

- **id:** `choose-logbird`
- **heading:** When to choose Logbird
- **bullets:**
  - Your audit data must **stay on your own servers**, or you want to read and change the code.
  - You want to **start sending without defining schemas first**, and add fields over time.
  - Your team needs an **operator console**: search with a query language or SQL, entity pages, operation trees,
    workers and retries.
  - You need to **lower retention**, not only raise it, and see what will be deleted before it happens.
- **cta:** Self-host it → `/self-hosting` · Join the waitlist → `/contact`
- **visual:** none

## sources

- **id:** `sources`
- **heading:** Sources
- **data:** the numbered sources are rendered from `apps/web/src/content/comparisons.ts`, its only source.
- **data:** what we couldn't verify is rendered from `apps/web/src/content/comparisons.ts`, its only source.
- **visual:** none
