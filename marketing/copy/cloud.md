---
title: Logbird Cloud and pricing
description: Logbird Cloud will run the same open-source codebase for you. It isn't open yet. Join the waitlist. Pricing isn't set yet.
path: /cloud
---

Page text renders from `apps/web/src/content/cloud.ts` (the plan cards from `apps/web/src/content/pricing.ts`); edit it there. This file is the brief: jobs, sources and owner notes.

# Cloud and pricing

> **Cloud open (`WEB_APP_URL` set, see README § Cloud CTA rule).** Hero body: "Logbird Cloud runs the same open-source
> codebase you can self-host. We run the servers, the upgrades and the backups. It's in early access: sign-ups are
> limited to invited teams for now. Request access, or sign in if you've been invited." CTAs: Request access → `/contact`
> · Sign in → `<WEB_APP_URL>/login`. Status panel: Logbird Cloud — Early access · Invited teams; Pricing — Isn't set yet ·
> Published before sign-ups open. Cloud card: "Early access" / "We run it for you. Open to invited teams for now." FAQ:
> "When can everyone sign up?" (no date; request access); region: "We'll publish the hosting region with the Cloud's
> launch terms. Ask us before you send production data. If your data must stay in a particular place, self-host
> Logbird." Closing band: "Want early access?" The waitlist variants below apply while `WEB_APP_URL` is unset.

## hero

- **id:** `hero`
- **eyebrow:** Logbird Cloud
- **heading (H1):** The same Logbird, run by us.
- **body:** Logbird Cloud will run the same open-source codebase you can self-host. We'll run the servers,
  the upgrades and the backups. It isn't open yet. Join the waitlist and we'll email you when it is.
  <!-- private build: "…codebase you'll be able to self-host." -->
- **body (when Cloud is open):** Logbird Cloud runs the same open-source codebase you can self-host. We run the
  servers, the upgrades and the backups. It's in early access: sign-ups are limited to invited teams for now. Request
  access, or sign in if you've been invited.
  <!-- source: docs/SPEC.md intro ("one codebase, self-host or cloud"); docs/deployment.md ("No cloud deployment or public signup is assumed") -->
- **cta (primary):** Join the waitlist → `/contact`
- **cta (secondary):** Self-host it → `/self-hosting` <!-- private build: "Self-host when the source opens" →
  /contact?interest=self-host (see README.md § Self-host CTA rule) -->
- **cta (when Cloud is open):** Request access → `/contact` · Sign in → `<sign-in URL>`
- **eyebrow:** Where things stand
- **facts panel:** Logbird Cloud — Not open yet Waitlist · Pricing — <pricing status> · Self-host —
  Available today Free, MIT <!-- private build: Self-host — When the source opens -->
- **facts panel (when Cloud is open):** Logbird Cloud — Early access Invited teams · Pricing — <pricing status> ·
  Self-host — Available today Free, MIT

## pricing

- **id:** `pricing`
- **eyebrow:** Pricing
- **heading:** <pricing heading>
- **body:** <pricing summary>
  <!-- The pricing words come from apps/web/src/content/pricing.ts (`pricing.cloud`; brief and sources: pricing.md), so approval is a data-only change. Today: "Pricing isn't set yet." / "Self-hosting is free under the MIT licence. Logbird Cloud is free during early access (/legal/terms); its pricing after that will be published before billing starts." -->
- **cards (no prices, no limits):**
  1. **Self-host.** Free, MIT. Free and MIT-licensed. Every feature in the repository. You run it.
     CTA: Self-host it → `/self-hosting`
     <!-- private build: "Free and MIT-licensed once the source opens, with every feature in the repository. You'll run it." -->
  2. **Cloud.** Waitlist. We'll run it for you. Free during early access; waitlist only for now.
     CTA: Join the waitlist → `/contact`
  3. **Support and enterprise.** Talk to us. For teams that want help running Logbird, or terms we haven't covered here.
     CTA: Contact us → `/contact`
- **cards (when Cloud is open):**
  1. **Self-host.** Free, MIT. Free and MIT-licensed. Every feature in the repository. You run it.
     CTA: Self-host it → `/self-hosting`
  2. **Cloud.** Early access. We run it for you. Free during early access, which is open to invited teams for now.
     CTA: Request access → `/contact`
  3. **Support and enterprise.** Talk to us. For teams that want help running Logbird, or terms we haven't covered here.
     CTA: Contact us → `/contact`
- **cta:** See pricing → `/pricing`
- **small print:** Nothing on this page is an offer.
- **visual:** none. Three equal cards with no prices or "per month" text.

## faq

- **id:** `faq`
- **eyebrow:** Questions
- **heading:** Cloud questions, answered as far as we can today.
- **items:**
  - **When does Logbird Cloud open?** We haven't set a date. People on the waitlist hear first.
  - **Where will my data be stored?** Not decided yet. We'll publish the hosting region before the cloud opens. If
    your data must stay in a particular place today, self-host Logbird.
    <!-- private build: "If your data must stay in a particular place, self-hosting is an option once the source opens." -->
  - **Is the cloud a different product?** No. It will run the same codebase as the self-hosted version. One difference
    is already decided: Logbird Cloud won't offer a free-form SQL console. The guarded SQL `WHERE` mode in the explorer
    is in both. <!-- source: docs/SPEC.md intro, §5.1.2; docs/roadmap.md -->
  - **Can I move between self-host and cloud?** Not with a tool or a guide. Logbird Cloud will run the same codebase,
    but there's no migration tool and no documented migration path yet.
  - **How much will it cost?** <pricing summary>
  - **Will there be an SLA?** There are no published service levels or limits yet.
    <!-- docs/roadmap.md lists measured limits as a candidate with no date, so the page states the absence and stops (maintainer rule, 2026-11-22) -->
  - **What do you do with my waitlist email?** We store it to contact you about Logbird. No trackers. See
    the [privacy policy](/legal/privacy).
- **items (when Cloud is open):**
  - **When can everyone sign up?** We haven't set a date. Logbird Cloud is in early access: sign-ups are limited to
    invited teams while we onboard them. Request access and we'll be in touch.
  - **Where will my data be stored?** We'll publish the hosting region with the Cloud's launch terms. Ask us before you
    send production data. If your data must stay in a particular place, self-host Logbird.
    <!-- private build: "If your data must stay in a particular place, self-hosting is an option once the source opens." -->
  - **Is the cloud a different product?** No. It runs the same codebase as the self-hosted version. One difference is
    already decided: Logbird Cloud won't offer a free-form SQL console. The guarded SQL `WHERE` mode in the explorer
    is in both.
  - **Can I move between self-host and cloud?** Not with a tool or a guide today. Both run the same codebase, but
    there's no migration tool and no documented migration path yet.
  - **How much will it cost?** <pricing summary>
  - **Will there be an SLA?** Not during early access. There are no published service levels or limits yet.
  - **What do you do with the email I give you?** We store it to contact you about Logbird. No trackers. See the
    [privacy policy](/legal/privacy).
- **visual:** none

## final-cta

- **id:** `final-cta`
- **heading:** Be first to hear when it opens.
- **heading (when Cloud is open):** Want early access?
- **body (when Cloud is open):** Self-host Logbird today, or request access to Logbird Cloud, where sign-ups are limited
  to invited teams for now.
- **cta:** Join the waitlist → `/contact`
- **cta (when Cloud is open):** Request access → `/contact`
- **visual:** none
