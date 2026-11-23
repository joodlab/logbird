---
title: Logbird and Bemi compared
description: Bemi captures every Postgres row change automatically. Logbird records the actions your app reports. Different tools, sometimes used together.
path: /compare/bemi
---

Page text renders from `apps/web/src/content/comparisons.ts` (the facts and sources) and `apps/web/src/content/compare.ts` (the page furniture); edit it there. This file is the brief: jobs, sources and owner notes.

# Logbird and Bemi

## summary

- **id:** `summary`
- **eyebrow:** Compare
- **heading (H1):** Logbird and Bemi
- **body:** Bemi is a different kind of tool. It connects to your Postgres write-ahead log and records every row
  change automatically: the table, the primary key, the operation, and the row before and after. Its ORM packages
  attach application context, such as the user or the endpoint, to each change. You don't instrument call sites,
  and nothing is missed because someone forgot an `audit()` call. Logbird works the other way round: your code
  reports actions, including ones that never touch your database. [B1–B4]
- **category note (shown as a callout titled "A different category"):** Bemi is automatic database change data capture for Postgres. Logbird is an
  application audit log. Many teams could use both: Bemi as the record of every row change, and Logbird as the
  readable history of who did what.
- **visual:** diagram: two lanes. Top lane, "Bemi": app → Postgres → WAL → Bemi → `changes` table (rows: table,
  primary_key, operation, before, after, context). Bottom lane, "Logbird": app code → `audit('booking.cancelled')` →
  Logbird → explorer (actor, tenant, executor, targets, changes). No logos.

## table

- **id:** `table`
- **heading:** At a glance
- **data:** the "At a glance" table is rendered from `apps/web/src/content/comparisons.ts`, its only source.

- **visual:** none

## choose-them

- **id:** `choose-bemi`
- **heading:** When to choose Bemi
- **bullets:**
  - You want **every row change in Postgres captured automatically**, without touching hundreds of call sites.
  - You need **before-and-after rows** for every change, including ones made by scripts or migrations outside your
    app's code paths.
  - You want to **query history from your ORM**, next to your data.
- **visual:** none

## choose-us

- **id:** `choose-logbird`
- **heading:** When to choose Logbird
- **bullets:**
  - You want to record **actions, not rows**: a sign-in, a denied request, a failed payment, an export, or work
    done in a queue worker that touches no table.
  - Your data lives in **more than one store**, or not in Postgres.
  - You need the **actor, the executor and the impersonator** on each event, with operation trees across
    requests and jobs.
  - You want **an MIT-licensed, self-hosted** audit log with retention controls included.
- **cta:** Self-host it → `/self-hosting` · Join the waitlist → `/contact`
- **visual:** none

## sources

- **id:** `sources`
- **heading:** Sources
- **data:** the numbered sources are rendered from `apps/web/src/content/comparisons.ts`, its only source.
- **data:** what we couldn't verify is rendered from `apps/web/src/content/comparisons.ts`, its only source.
- **visual:** none
