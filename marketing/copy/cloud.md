---
title: Logbird Cloud and pricing
description: Logbird Cloud runs the same open-source codebase for you. It isn't open yet. Join the waitlist. Pricing isn't set yet.
path: /cloud
---

# Cloud and pricing

## hero

- **id:** `hero`
- **eyebrow:** Logbird Cloud
- **heading (H1):** The same Logbird, run by us.
- **body:** Logbird Cloud will run the same open-source codebase you can self-host. We run the servers, the
  upgrades and the backups. It isn't open yet. Join the waitlist and we'll email you when it is.
  <!-- source: docs/SPEC.md intro ("one codebase, self-host or cloud"); docs/deployment.md ("No cloud deployment or public signup is assumed") -->
- **cta (primary):** Join the waitlist → `/contact`
- **cta (secondary):** while the repository is private: "Self-host when the source opens" → `/contact?interest=self-host`;
  once `WEB_GITHUB_PUBLIC=true`: "Self-host it today" → `/self-hosting` (see `README.md` § Self-host CTA rule)
- **visual:** none, or the social card `apps/app/public/brand/logbird-og.png`

## pricing

- **id:** `pricing`
- **eyebrow:** Pricing
- **heading:** Pricing isn't set yet.
- **body:** We'll publish prices before Logbird Cloud opens. Here is the shape we're planning. Nothing here is final.
- **cards (no prices, no limits):**
  1. **Self-host.** Free and MIT-licensed. Every feature in the repository. You run it.
     CTA: Self-host it → `/self-hosting`
  2. **Cloud.** We run it for you. Waitlist only for now.
     CTA: Join the waitlist → `/contact`
  3. **Support and enterprise.** For teams that want help running Logbird, or terms we haven't covered here.
     CTA: Contact us → `/contact`
- **small print:** "Plans, prices and limits will be announced before launch. Nothing on this page is an offer."
- **visual:** none. Three equal cards with no prices or "per month" text.

## faq

- **id:** `faq`
- **eyebrow:** Questions
- **heading:** Cloud questions, answered as far as we can today.
- **items:**
  - **When does Logbird Cloud open?** We haven't set a date. People on the waitlist hear first.
  - **Where will my data be stored?** Not decided yet. We'll publish the hosting region before the cloud opens. If
    your data must stay in a particular place today, self-host Logbird.
  - **Is the cloud a different product?** No. It runs the same codebase as the self-hosted version. One difference is
    already decided: Logbird Cloud won't offer a free-form SQL console. The guarded SQL `WHERE` mode in the explorer
    is in both. <!-- source: docs/SPEC.md intro, §5.1.2; docs/roadmap.md -->
  - **Can I move between self-host and cloud?** We'll document how to migrate before the cloud opens. There's no
    migration tool today.
  - **How much will it cost?** Pricing isn't set yet. Self-hosting is free under the MIT licence.
  - **Will there be an SLA?** We'll publish service levels and limits together with the cloud's launch terms.
    <!-- source: docs/roadmap.md P1-5 ("Published SLOs and limits") is a plan, not a commitment -->
  - **What do you do with my waitlist email?** We store it to contact you about Logbird. No trackers. See
    `/legal/privacy`.
- **visual:** none

## final-cta

- **id:** `final-cta`
- **heading:** Be first to hear when it opens.
- **cta:** Join the waitlist → `/contact`
- **visual:** none
