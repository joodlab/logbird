---
title: Logbird and Retraced compared
description: Retraced is an Apache-2.0 audit log service with an embeddable React viewer. How it compares with Logbird, sourced and dated.
path: /compare/retraced
---

# Logbird and Retraced

## summary

- **id:** `summary`
- **eyebrow:** Compare
- **heading (H1):** Logbird and Retraced
- **body:** Retraced is an open-source audit log service. Replicated created it, and BoxyHQ later co-maintained it. It
  has an API to send events, an embeddable viewer so your customers can browse their own events, and an Enterprise
  API so their IT teams can pull events out programmatically. It runs on Postgres with optional Elasticsearch, and you
  deploy it yourself. Its embeddable, customer-facing viewer is a real strength: Logbird doesn't have one today.
  [S1–S4]
- **visual:** none

## table

- **id:** `table`
- **heading:** At a glance
- **data:** the "At a glance" table is rendered from `apps/web/src/content/comparisons.ts`, its only source.

- **visual:** none

## choose-them

- **id:** `choose-retraced`
- **heading:** When to choose Retraced
- **bullets:**
  - You want to **embed an audit log viewer in your own React app**, so customers can browse their own events.
  - Your customers' IT teams need a **programmatic API of their own** to pull their events.
  - You prefer **Apache-2.0**, or you already run Postgres and Elasticsearch and want the audit log there too.
  - You want a project with **a long release history** behind it. Logbird's first release was v`<first release>`, on `<first release date>`.
- **visual:** none

## choose-us

- **id:** `choose-logbird`
- **heading:** When to choose Logbird
- **bullets:**
  - You want to **send any event shape** and get a recommended envelope without a fixed schema.
  - Your team needs an **operator console** that can follow actors, tenants, workers and records, and show operation
    trees with retries.
  - You need **retention you can explain**: a window per project, a preview of what will be deleted, and permanent
    deletion.
  - You want events stored in **ClickHouse**, with a SQL `WHERE` mode for hard questions.
- **cta:** Self-host it → `/self-hosting` · Join the waitlist → `/contact`
- **visual:** none

## sources

- **id:** `sources`
- **heading:** Sources
- **data:** the numbered sources are rendered from `apps/web/src/content/comparisons.ts`, its only source.
- **data:** what we couldn't verify is rendered from `apps/web/src/content/comparisons.ts`, its only source.
- **visual:** none
