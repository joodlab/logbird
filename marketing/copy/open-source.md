---
title: Open source — Logbird
description: Logbird is MIT-licensed. API, console, worker, SDK and integrations live in one repository, which opens publicly soon.
path: /open-source
---

# Open source

## hero

- **id:** `hero`
- **eyebrow:** Open source
- **heading (H1):** MIT-licensed. All of it.
- **body:** Logbird is released under the MIT licence. The API, the console, the retention worker, the SDK and the
  integrations are in one repository. You can read the code, run it, change it and ship it in your own product.
  <!-- source: LICENSE ("MIT License, Copyright (c) 2026 Joodlab") -->
- **cta:** Source on GitHub — coming soon (disabled button, no link) · Self-host it → `/self-hosting`
- **small print:** The repository opens publicly soon. Until then, the code isn't public.
- **visual:** a LICENSE card: "MIT License", "Copyright (c) 2026 Joodlab", the licence's first sentence (truncated),
  and four checks: Read it · Run it · Change it · Ship it in your product.

## in-the-repo

- **id:** `repo`
- **eyebrow:** What's in the repository
- **heading:** One repository, one codebase.
- **table:**

  | Path | What it is |
  | --- | --- |
  | `apps/server` | The API: ingest and read on `/v1`, the console API on `/api`, OpenAPI and a Scalar reference. Hono on Node. |
  | `apps/app` | The console. TanStack Start and React. |
  | `apps/worker` | The retention worker: hourly purges and housekeeping. BullMQ on Redis or Dragonfly. |
  | `apps/email` | Previews for the sign-in and invitation email templates. |
  | `packages/contracts` | The API's request and response schemas. The source of truth for the API. |
  | `packages/clickhouse` | ClickHouse client, migrations, query builder and query-language parser. |
  | `packages/database` | Postgres schema (Prisma): workspaces, projects, keys, saved views. |
  | `packages/auth` | Email one-time-code sign-in and workspaces, on better-auth. |
  | `packages/sdk` | `@logbird/sdk`: the TypeScript client. No dependencies. |
  | `packages/integrations/*` | `@logbird/hono`, `@logbird/tanstack-start`, `@logbird/vue`, `@logbird/nuxt`. |
  | `packages/ui` | The console's design system. |
  | `packages/seed` | A generator of fictional hotel-booking data, sent through the public API. |
  | `examples/*` | Small runnable examples for each integration. |

  <!-- source: docs/SPEC.md §2; ls apps packages examples -->
- **visual:** none

## contributing

- **id:** `contributing`
- **eyebrow:** Contributing
- **heading:** How to contribute.
- **body:** Once the repository is public, contributions follow `CONTRIBUTING.md`. In short: Node 22.18+ and pnpm,
  focused branches, Conventional Commits, and pull requests that explain what changed, why, and how it was verified.
  UI changes include screenshots. Tests use fictional data only. Maintainers merge.
  <!-- source: CONTRIBUTING.md; AGENTS.md -->
- **checklist (from the body):** Node 22.18+ and pnpm · Focused branches and Conventional Commits · Pull requests that
  explain what changed, why, and how it was verified · Screenshots for UI changes · Fictional data only in tests ·
  Maintainers merge.
- **bullets:**
  - API changes start in `packages/contracts`. The server and console change in the same pull request.
  - There are no CI workflows yet. Checks and Docker builds run by hand before a release.
- **visual:** none

## conduct

- **id:** `conduct`
- **eyebrow:** Code of conduct
- **heading:** Be kind and constructive.
- **body:** The project follows the Contributor Covenant, version 2.1. Report conduct issues through the private
  channel described in `SECURITY.md`.
  <!-- source: CODE_OF_CONDUCT.md -->
- **visual:** none

## security

- **id:** `security`
- **eyebrow:** Security reports
- **heading:** Found a vulnerability? Tell us privately.
- **body:** Don't open a public issue. Email the security contact (`SECURITY_EMAIL` in `apps/web/src/env.ts`).
  Include the affected version, a reproduction with fictional data, and the impact. We coordinate the fix and the
  disclosure with you privately. We don't offer a response-time SLA yet.
  <!-- site rule: the site names only the security email, never a GitHub reporting flow -->
  <!-- source: SECURITY.md -->
- **cta:** Security and data handling → `/security`
- **visual:** none

## versions

- **id:** `versions`
- **eyebrow:** Versions
- **heading:** Where the project is today.
- **body:** Version 0.1 is the first supported line. The SDK and the Hono integration are at 0.2. Nothing has been
  released yet: there are no npm packages or Docker images. Both come with the first release.
  <!-- source: SECURITY.md ("Version 0.1.x is the initial supported line"); CHANGELOG.md (both "Unreleased"); packages/sdk/package.json (0.2.0) -->
- **facts panel:** Supported line — 0.1 · SDK and Hono integration — 0.2 · npm packages — Not released · Docker images —
  Not released.
- **cta:** Read the changelog → `/changelog`
- **visual:** none
