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
- **table:**

  | | Logbird | Retraced |
  | --- | --- | --- |
  | Licence | MIT | Apache-2.0 [S5] |
  | Self-host | Planned: Docker Compose or Coolify, when the source opens ("Yes: …, built from source" once public) | Yes: Docker Compose; also documented for DigitalOcean, AWS and Skaffold; the Kubernetes docs page says "Coming soon" [S6, S7] |
  | Hosted offering | Logbird Cloud: waitlist only | None found [S8] |
  | Required event fields | `action` only; any other shape accepted | `action` and `crud` in the API spec; the docs also list `actor` as mandatory [S9, S10] |
  | Tenant field | `tenant` (optional) | `group` (optional in the API spec) [S10] |
  | Search | Query language with ranges, regex and groups; guarded SQL `WHERE` mode in the console | GraphQL search; free text or `key:value` filters on `action`, `crud`, `received` and `actor` [S11, S12] |
  | Retention | Per project, 7 days to 10 years; hourly permanent deletion with a preview | No retention setting in the documented configuration [S13] |
  | Customer-facing viewer | None yet; read API plus headless Vue helpers | Embeddable React viewer (`@retracedhq/logs-viewer`), with scoped viewer tokens [S14] |
  | Programmatic read | `GET /v1/events` with a project read key | Enterprise API (GraphQL) for end customers [S15] |
  | Storage | ClickHouse for events, Postgres for metadata | Postgres; optional Elasticsearch; NSQ queue [S4, S13] |
  | Pricing | Self-host free (MIT); Cloud pricing not set | No pricing page found [S8] |
  | Latest release | Not released yet (0.1 line) | v1.13.1, 6 Nov 2024; latest commit on `main` 26 Aug 2025; not archived [S16, S17] |

- **visual:** none

## choose-them

- **id:** `choose-retraced`
- **heading:** When to choose Retraced
- **bullets:**
  - You want to **embed an audit log viewer in your own React app**, so customers can browse their own events.
  - Your customers' IT teams need a **programmatic API of their own** to pull their events.
  - You prefer **Apache-2.0**, or you already run Postgres and Elasticsearch and want the audit log there too.
  - You want a project with **a release history** behind it. Logbird hasn't made its first release yet.
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
- **cta:** Self-host Logbird → `/self-hosting` · Join the waitlist → `/contact`
- **visual:** none

## sources

- **id:** `sources`
- **heading:** Sources (all accessed 2026-11-07)
- **list:**
  - S1 — Repository description: "A fully open source audit logs service and embeddable UI…".
    https://github.com/retracedhq/retraced
  - S2 — README: searchable, exportable record of events; Go and JavaScript clients.
    https://raw.githubusercontent.com/retracedhq/retraced/main/README.md
  - S3 — Basics: Publisher API, embedded Logs Viewer, Enterprise IT Integration API.
    https://raw.githubusercontent.com/retracedhq/docs/main/getting-started/retraced-basics.md
  - S4 — Docs overview: "Supports Postgres for now"; Elasticsearch optional.
    https://raw.githubusercontent.com/retracedhq/docs/main/README.md
  - S5 — Licence file: Apache License, Copyright 2019 Replicated, Inc.
    https://raw.githubusercontent.com/retracedhq/retraced/main/LICENSE
  - S6 — Self-host options: Docker, DigitalOcean, AWS, Kubernetes, Skaffold.
    https://raw.githubusercontent.com/retracedhq/docs/main/self-host/index.md
  - S7 — Kubernetes page: "Coming soon". https://raw.githubusercontent.com/retracedhq/docs/main/self-host/kubernetes.md
  - S8 — No hosted service or pricing found. boxyhq.com redirects to ory.sh, and the Ory pricing page doesn't list
    Retraced. A 2024 Ory changelog post says "Audit logs are currently a self-hosted only feature".
    https://www.ory.com/pricing · https://www.ory.com/blog/changelog-saml-jackson-2024
  - S9 — Publisher API docs: mandatory `action`, `crud`, `actor`.
    https://raw.githubusercontent.com/retracedhq/docs/main/apis/publisher-api.md
  - S10 — API spec `CreateEventRequest`: required `action`, `crud`; optional `group`, `actor`, `target` and more.
    https://raw.githubusercontent.com/retracedhq/retraced/main/swagger.json
  - S11 — GraphQL search endpoints. https://raw.githubusercontent.com/retracedhq/docs/main/apis/graphql.md
  - S12 — Search syntax. https://raw.githubusercontent.com/retracedhq/docs/main/getting-started/searching-for-events.md
  - S13 — Environment variables: Postgres, Elasticsearch, NSQ, `PG_SEARCH`; no retention settings.
    https://raw.githubusercontent.com/retracedhq/docs/main/self-host/env-variables.md
  - S14 — Embedded viewer: `@retracedhq/logs-viewer`, `RetracedEventsBrowser`, group-scoped viewer token.
    https://raw.githubusercontent.com/retracedhq/docs/main/getting-started/embedded-viewer.md
  - S15 — Enterprise API. https://raw.githubusercontent.com/retracedhq/docs/main/exposing-retraced-data/enterprise-api.md
  - S16 — Releases: v1.13.1, published 2024-11-06. https://api.github.com/repos/retracedhq/retraced/releases
  - S17 — Commits: latest on `main` 2025-08-26; `archived: false`.
    https://api.github.com/repos/retracedhq/retraced/commits · https://api.github.com/repos/retracedhq/retraced
- **unverified (left out of the table):** who maintains Retraced today (boxyhq.com now redirects to Ory, and we found
  no statement from Ory about Retraced); whether OpenSearch or the repository's Helm files are supported; any retention or deletion
  job outside the documented configuration; CSV export details.
- **visual:** none
