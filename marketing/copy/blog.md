---
title: Blog — Logbird
description: Notes on building an open-source audit log: design decisions, guarantees and limits, written by the people building Logbird.
path: /blog
---

# Blog

## index-intro

- **id:** `intro`
- **eyebrow:** Blog
- **heading (H1):** Notes from building Logbird.
- **body:** Longer posts on how Logbird works and why: the decisions, the guarantees, and the limits. For day-by-day
  progress, see the changelog. (The last sentence and the CTA appear only once `/changelog` is ready.)
- **cta:** Changelog and build log → `/changelog`
- **empty state:** No posts yet. The first one is on its way.
- **site:** posts live in `apps/web/src/lib/publications.ts`. The blog is `ready` from the first published post; the
  draft below isn't on the site.
- **visual:** none

---

## post: why-were-building-logbird

> **DRAFT. Not approved for publication.** The owner publishes posts (`marketing/README.md`).

- **front matter for the post page:**
  - `title`: Why we're building Logbird
  - `description`: Every product owes its customers an answer to "who changed this?". Here's why we built an
    open-source audit log to give it, and what it promises.
  - `path`: `/blog/why-were-building-logbird`
  - `author`: (owner to fill)
  - `date`: (on publication)
- **visual (header):** `marketing/captures/2026-11-06-logbird-rename/04-explorer-light.png` (after re-capture; see
  `README.md` § Captures)

### Why we're building Logbird

Sooner or later, every product gets the same support ticket. A customer's booking was cancelled, a price changed,
a user disappeared from a team. They want to know who did it, and when.

Most teams answer it badly. They grep application logs that were never meant to be kept. They add an `audit_logs`
table to Postgres and watch it grow next to the data it describes. Or they rent a closed service and accept that
the record of what happened in their own product lives with someone else.

We had that ticket too. We're working with a hotel-booking SaaS, our first design partner. Its API has hundreds of
routes that change data, and a fleet of background workers that change more. So we built the audit log we wanted
for it, and we're releasing it under the MIT licence.

**Send any shape.** An event is any JSON object with an `action`. That's the only required field. We recommend an
envelope: who caused it (the actor), what performed it (the executor), whose account (the tenant), which records,
what changed, and which operation it belongs to. Logbird tells you how much of that envelope each event fills, but it
never drops an event for being incomplete. A half-instrumented audit log you ship this week beats a perfect one you
ship next quarter.

**Separate who asked from what did the work.** When Lina asks for a refund and a queue worker carries it out, Lina is
the actor and the worker is the executor. When support acts on her behalf, the support agent is the impersonator and
Lina is still the actor. Getting this right is most of what makes an audit log useful, so the SDK carries the actor
from the request into the job for you.

**Write the guarantees down.** When the server answers `202`, the event is in ClickHouse. Delivery is at least once,
so counts may include duplicates. The SDK's queue lives in memory, so a crash before that `202` can lose events.
Retention deletes are permanent: when you lower a project's window, you type its slug, and the expired events are
gone. We'd rather you read those sentences now than discover them during an incident.

**Run it yourself.** Logbird self-hosts with Docker Compose: the API, the console, a retention worker, Postgres,
ClickHouse and Redis. Your events never leave your servers. Logbird Cloud will run the same codebase for people who
don't want to operate it. It isn't open yet, and we haven't set prices.

What's not there yet: published images, npm packages, SSO, alerts, streaming export, and a customer-facing viewer
with tenant-scoped tokens. They're on the roadmap, and we'll write about each one as it lands.

The repository opens publicly soon. If you'd like to hear when Logbird Cloud opens, join the waitlist.

**CTA at the end of the post:** Join the waitlist → `/contact` · Self-host it → `/self-hosting`

<!-- sources: docs/SPEC.md §1–§3; docs/concepts.md; packages/sdk/README.md; README.md; docs/roadmap.md (P0 intro, P1, P2); docs/self-hosting.md -->
