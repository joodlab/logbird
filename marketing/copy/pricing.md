---
path: /pricing
module: apps/web/src/content/pricing.ts
---

# Pricing: brief

**The words and data live in the module.** `/pricing` and the plan cards on `/cloud` render
`apps/web/src/content/pricing.ts`. The roadmap section renders `apps/web/src/content/roadmap.ts`, shared with `/product`.
This file holds the page's job, the proof behind every claim and the rules for changing it. It doesn't restate page text.

## The page's job

Answer "what does Logbird cost?" truthfully today:
- self-hosting is free under the MIT licence, with every feature in the repository;
- Logbird Cloud's pricing isn't set, and here is how to get early access;
- support and enterprise means talking to us.

Before this page, `/pricing` was a 404.

## What may be on this page (maintainer ruling, 2026-11-22)

- **Only the three public plans:** `self-host`, `cloud`, `support`.
- **Not in this repository** until the owner approves Logbird Cloud's pricing: anything about it beyond "not set yet". The repository is public, so committing it would disclose it even on an unpublished page.
- **No plan comparison:** the feature list is what is available today.
- **Roadmap rows** only for items `docs/roadmap.md` lists, under `roadmap-claims.test.ts`.
- **Scoped read access** appears only behind `SCOPED_READ_LIVE`, after the maintainer confirms its production proof.
- **Structured data:** no Cloud offer until prices are approved. The home page's free self-hosted offer stays.

## How approved pricing arrives (one change, data only)

In `content/pricing.ts`, add the plans with their `figures` and the `dimensions` they differ on, then flip
`PRICING_APPROVED`. Figures render on the plan cards as soon as a plan has one for a dimension. With `PRICING_APPROVED` on and `WEB_CHECKOUT_URL` set, the Cloud plan's button links to checkout; until then it is the access call to action. `pricing.test.ts` fails if a price, a named plan, a usage unit or a checkout link renders while `PRICING_APPROVED` is off. The paste-ready data for the owner's proposal is kept with the private proposal, not here.

## State variants

| State | What changes | Module keys |
| --- | --- | --- |
| Repository private | "will be free once the source opens"; the self-host card leads to the waitlist | `meta.description`, `hero.title`, `hero.lead`, `faq.items[0]`, `shared.selfHostCta` |
| Cloud open (`WEB_APP_URL`) | "Early access", "runs the same codebase for you, in early access", request access | `plans[1]`, `hero.lead`, `faq.items[2]`, `shared.accessCta` |
| Scoped read proven (`SCOPED_READ_LIVE`) | A "Customer-facing history" row joins the feature list | `included.features` |

## Proof

| Claim (module key) | Source |
| --- | --- |
| Self-hosting is free, MIT-licensed, with every feature in the repository (`hero`, `plans[0]`, `faq.items[0]`, `included.lead`) | `LICENSE` |
| Logbird Cloud runs (or will run) the same codebase; early access or waitlist by state (`hero.lead`, `plans[1]`) | `marketing/copy/cloud.md` hero; `content/shared.ts` (Cloud CTA rule) |
| Cloud pricing isn't set and will be published before billing starts (`hero`, `faq.items[1]`) | Maintainer ruling 2026-11-22; `/legal/terms` (fees are announced in advance) |
| Support and enterprise: talk to us (`plans[2]`) | The existing `/cloud` card |
| Each feature in "What you get when you self-host" (`included.features`) | The `source` field on each row in `content/pricing.ts` |
| The roadmap items (`roadmap`) | `docs/roadmap.md`, item by item in `content/roadmap.ts` |
