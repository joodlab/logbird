---
title: About Logbird
description: Logbird is an open-source audit log for teams who owe their customers a trail of who did what.
path: /about
---

# About

## intro

- **id:** `intro`
- **eyebrow:** About
- **heading (H1):** We built the audit log we needed.
- **body:** Logbird started as the audit log a product team needed, where every support question begins the same
  way: who changed this, and when? We wanted the answer to take one search, on servers we run ourselves. It's
  MIT-licensed, and the source opens publicly soon, so any product team can do the same.
  <!-- once WEB_GITHUB_PUBLIC=true: "We released it under the MIT licence so any product team can do the same." -->
  <!-- source: docs/SPEC.md intro (audience) and docs/roadmap.md intro -->
  <!-- owner-gated: org-name, origin-story. Only once the owner approves WEB_ORG_NAME and the origin story:
       "Logbird is built by {WEB_ORG_NAME}. It started as the audit log for a hotel-booking SaaS, where every support
       question begins the same way: …" -->

- **site:** while `WEB_ORG_NAME` is set, the lead starts with "Logbird is built by {WEB_ORG_NAME}." The origin story
  stays the neutral version above until the owner approves it.
- **visual:** none

## design-partner

- **id:** `design-partner`
- **eyebrow:** First design partner
- **heading:** Shaped by a real product.
- **body:** Logbird is being integrated with a hotel-booking SaaS, our first design partner. Integration feedback helps
  inform the roadmap.
  <!-- site: rendered from DESIGN_PARTNER_LINE (apps/web/src/lib/copy-flags.ts), shared with the home page -->
  <!-- source: docs/roadmap.md intro. Named variant is owner-gated: see README.md § Owner-gated copy -->
- **visual:** none

## principles

- **id:** `principles`
- **eyebrow:** What we hold to
- **heading:** Five decisions that don't change.
- **bullets:**
  1. **Accept anything.** Any JSON object with an `action` is a valid event. We recommend a shape; we never reject
     an event for missing it.
  2. **Capture is your code's job.** We give you the SDK, the integrations and the patterns. Our guarantee starts at
     the `202`.
  3. **History starts when capture starts.** There's no backfill.
  4. **Retention means deletion.** Expired events are deleted for good.
  5. **We audit ourselves.** Logbird records its own management actions in your workspace's activity stream.
  <!-- source: docs/SPEC.md §1; docs/roadmap.md ("Product decisions stay fixed") -->
- **visual:** none

## name

- **id:** `name`
- **eyebrow:** The name
- **heading:** Logbird
- **body:** The bird that carries every event home. We chose a short name made of two words you already know, so anyone
  who hears it once can spell it.
  <!-- source: docs/brand.md §1 -->
- **visual:** `apps/app/public/brand/logbird-wordmark-light.svg` (dark: `-dark.svg`)

## build-in-public

- **id:** `build-in-public`
- **eyebrow:** Building in public
- **heading:** Follow the build.
- **body:** We write up what we ship as we go. Every post uses real captures from the product.
- **cta:** Read the changelog → `/changelog` · Contact us → `/contact`
- **site:** this section renders only once `/changelog` is ready.
- **visual:** none
