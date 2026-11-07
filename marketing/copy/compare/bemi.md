---
title: Logbird and Bemi compared
description: Bemi captures every Postgres row change automatically. Logbird records the actions your app reports. Different tools, sometimes used together.
path: /compare/bemi
---

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
- **table:**

  | | Logbird | Bemi |
  | --- | --- | --- |
  | What it records | Actions your code reports, in any shape | Every insert, update and delete in tracked Postgres tables [B1, B3] |
  | How it captures | SDK or HTTP calls you add | Postgres logical replication (WAL), through Debezium and NATS JetStream [B1, B5] |
  | Databases | Any; Logbird doesn't read your database | PostgreSQL [B4, B5] |
  | Licence | MIT | Core: SSPL-1.0; ORM packages: LGPL-3.0 [B6, B7, B8] |
  | Self-host | Yes: Docker Compose or Coolify | Open-source version "designed for evaluation and non-critical workloads"; a licensed Self-Hosting Enterprise edition for production [B9] |
  | Hosted offering | Logbird Cloud: waitlist only | Bemi Cloud [B9] |
  | Data model | Recommended envelope: actor, executor, tenant, targets, changes, operation | `changes` table: database, schema, table, primary key, operation, before, after, context [B3] |
  | Query | Query language and guarded SQL `WHERE` mode in a console | SQL on the `changes` table, or ORM helpers (Prisma, Rails and others) [B3, B10, B11] |
  | Retention | Per project, 7 days to 10 years; hourly permanent deletion; self-host included | Automatic retention in Bemi Cloud; not included in the open-source self-hosted version [B3, B9] |
  | Storage engine | ClickHouse for events, Postgres for metadata | PostgreSQL [B3] |
  | Pricing | Self-host free (MIT); Cloud pricing not set | Starter $19/month, Business from $99/month, Enterprise custom (as listed on bemi.io on 2026-11-07) [B12] |

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
- **cta:** Self-host Logbird → `/self-hosting` · Join the waitlist → `/contact`
- **visual:** none

## sources

- **id:** `sources`
- **heading:** Sources (all accessed 2026-11-07)
- **list:**
  - B1 — README: tracks changes by connecting to the WAL using Change Data Capture; no table alterations.
    https://github.com/BemiHQ/bemi (now redirects to https://github.com/pgstack-io/bemi-io)
  - B2 — Website: "Automatic Audit Trail for Postgres". https://bemi.io
  - B3 — Destination database: `changes` table columns; Cloud retention; storage in PostgreSQL.
    https://docs.bemi.io/postgresql/destination-database
  - B4 — Docs home: "plugs into PostgreSQL and ORMs to track database changes automatically". https://docs.bemi.io
  - B5 — Source database: `wal_level = logical`, replication slot and publication.
    https://docs.bemi.io/postgresql/source-database
  - B6 — Core licence file: Server Side Public License, version 1.
    https://github.com/pgstack-io/bemi-io/blob/main/LICENSE
  - B7 — `bemi-prisma` licence file: LGPL-3.0. https://raw.githubusercontent.com/pgstack-io/bemi-prisma/main/LICENSE
  - B8 — `bemi-rails` README: "Distributed under the terms of the LGPL-3.0 License".
    https://github.com/pgstack-io/bemi-rails
  - B9 — Self-hosting: open-source version and Self-Hosting Enterprise; Cloud-only features.
    https://docs.bemi.io/self-hosting
  - B10 — Prisma integration. https://docs.bemi.io/orms/prisma
  - B11 — Rails integration. https://docs.bemi.io/orms/rails
  - B12 — Pricing. https://bemi.io/pricing
- **unverified (left out of the table):** Bemi's GitHub organization now redirects to `pgstack-io` (PgStack, from
  the same company, Bemi Technologies, Inc.), and pgstack.io lists a change-tracking product called "Audit" with
  different pricing. We found no announcement explaining the relationship, so this page describes Bemi as published
  on bemi.io and docs.bemi.io. Also unverified: which retention periods currently apply (the docs and the PgStack
  pricing page differ); supported PostgreSQL versions; whether a customer-facing viewer exists; licence files of the
  other ORM packages.
- **visual:** none
