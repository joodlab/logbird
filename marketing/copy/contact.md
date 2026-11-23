---
title: Contact Logbird — join the Cloud waitlist
description: Join the Logbird Cloud waitlist or send us a question. We store your email only to contact you about Logbird. No trackers.
path: /contact
---

Page text renders from `apps/web/src/content/contact.ts` (the form's labels, options and states from `apps/web/src/components/waitlist-form.tsx`); edit it there. This file is the brief: jobs, sources and owner notes.

# Contact

> **Cloud open (`WEB_APP_URL` set).** H1 "Request access, or ask us anything."; lead "Logbird Cloud is in early access,
> with sign-ups limited to invited teams. Leave your email to request access. If you have a question about self-hosting,
> support or something else, choose it below."; form heading "Request access"; interest "Access to Logbird Cloud";
> success (every topic, including privacy requests) "Thanks, we've got it. We'll reply by email."; an "Already
> invited? Sign in to Logbird Cloud" row; "Source and issues" links the repository and its issues.

## intro

- **id:** `intro`
- **eyebrow:** Contact
- **heading (H1):** Join the waitlist, or ask us anything.
- **heading (H1) (when Cloud is open):** Request access, or ask us anything.
- **body:** Logbird Cloud isn't open yet. Leave your email and we'll write when it is. If you have a question about
  self-hosting, support or something else, choose it below.
- **body (when Cloud is open):** Logbird Cloud is in early access, with sign-ups limited to invited teams. Leave your email
  to request access. If you have a question about self-hosting, support or something else, choose it below.
- **visual:** none

## form

- **id:** `form`
- **heading:** Join the waitlist.
- **heading (when Cloud is open):** Request access.
- **fields:**

  | Field | Label | Help text | Validation message |
  | --- | --- | --- | --- |
    | `email` (required) | Email | | Enter a valid email address. |
  | `name` (optional) | Name | | |
  | `company` (optional) | Company | | |
  | `topic` (required, radio) | What's this about? | | Choose one. |
  | `volume` (optional, select) | Expected events per month (optional) | | |
  | `needs` (optional, checkboxes) | What do you need? (optional) | | |
    | `message` (optional) | Message | What are you building, and what do you need from an audit log? For a privacy request, tell us what you'd like us to do. | |

- **topic options:** <!-- values: cloud, self-host, updates, correction, other, privacy -->
  - The Logbird Cloud waitlist
  - Self-hosting <!-- private build: "Self-hosting, when the source opens" -->
  - Product updates only
  - A correction to one of our pages
  - A question, or support and enterprise
  - A privacy request (access, deletion or another right)
- **topic options (when Cloud is open):**
  - Access to Logbird Cloud
  - Self-hosting
  - Product updates only
  - A correction to one of our pages
  - A question, or support and enterprise
  - A privacy request (access, deletion or another right)
- **volume options:** <!-- values: "" (sends nothing), unsure, under-100k, 100k-1m, 1m-10m, over-10m (apps/web/src/lib/waitlist-schema.ts) -->
  - Choose one
  - Not sure yet
  - Under 100,000
  - 100,000 to under 1 million
  - 1 million to under 10 million
  - 10 million or more
- **needs options:** <!-- values: customer-audit-log, compliance, investigations, self-host-support, other. Qualifying answers for the landing page's two jobs; no prices. The privacy policy's form section lists them. -->
  - Show our customers their own audit log
  - Compliance evidence and retention
  - Support investigations
  - Help running it ourselves
  - Something else
- **placeholder for email:** `you@example.test`
- **submit button:** Send
- **privacy note (under the button, `aria-describedby` on Send):** We use these details to reply to you and handle access
  requests, and send product updates only if you choose "Product updates only". No trackers. By sending, you confirm
  you've read the [privacy policy](/legal/privacy). <!-- recorded in legal-privacy.md § form-line -->
- **visual:** none

## states

- **id:** `states`
- **messages:**
  - **Sending (button label):** Sending…
  - **Success (every topic):** Thanks, we've got it. We'll reply by email. <!-- one message for every topic, so a privacy
    request is never told it joined a waitlist -->
  
  - **Error (validation, from the server):** Something in the form needs fixing. Check the email address and try again.
  - **Error (network or server):** We couldn't send that. Check your connection and try again, or email <contact email>.
    <!-- without WEB_CONTACT_EMAIL: "We couldn't send that. Check your connection and try again." -->
  - **Too many attempts:** Too many attempts. Wait a minute, then try again.
  - **Unavailable (form disabled, for example before the backend exists):** The form isn't available right now.
    Email us at <contact email> instead. <!-- without WEB_CONTACT_EMAIL: "The form isn't available right now. Please try again later." -->
    <!-- no mailbox is derived from the domain (logbird.joodlab.com); see README.md § Pending owner decisions -->
- **visual:** none

## other-channels

- **id:** `other-channels`
- **eyebrow:** Elsewhere
- **heading:** Other ways to reach us.
- **bullets:**
  - **Security issues:** Email <security contact>. <!-- without WEB_SECURITY_EMAIL: ask the maintainers for a private channel through this form (choose "A question"), without any details of the issue -->
  - **Source and issues:** On GitHub: report bugs and ask questions in issues. <!-- private build: "Source on GitHub — coming soon." -->
- **visual:** none
