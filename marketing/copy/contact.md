---
title: Contact Logbird — join the Cloud waitlist
description: Join the Logbird Cloud waitlist or send us a question. We store your email only to contact you about Logbird. No trackers.
path: /contact
---

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
- **body:** Logbird Cloud isn't open yet. Leave your email and we'll write when it is. If you have a question about
  self-hosting, support or something else, choose "A question" below.
- **visual:** none

## form

- **id:** `form`
- **fields:**

  | Field | Label | Help text | Validation message |
  | --- | --- | --- | --- |
    | `email` (required) | Email | | Enter a valid email address. |
  | `name` (optional) | Name | | |
  | `company` (optional) | Company | | |
  | `topic` (required, radio) | What's this about? | | Choose one. |
    | `message` (optional) | Message | What are you building, and what do you need from an audit log? For a privacy request, tell us what you'd like us to do. | |

- **topic options:**
    - `cloud` — "Access to Logbird Cloud" once `WEB_APP_URL` is set, otherwise "The Logbird Cloud waitlist" (default)
  - `self-host` — "Self-hosting" (before `WEB_GITHUB_PUBLIC=true`: "Self-hosting, when the source opens")
  - `updates` — Product updates only
  - `correction` — A correction to one of our pages
  - `other` — A question, or support and enterprise
  - `privacy` — A privacy request (access, deletion or another right)
- **placeholder for email:** `you@example.test`
- **submit button:** Send
- **privacy note (under the button, `aria-describedby` on Send):** the line recorded in `legal-privacy.md` § form-line,
  linking the privacy policy → `/legal/privacy`.
- **visual:** none

## states

- **id:** `states`
- **messages:**
  - **Sending (button label):** Sending…
  - **Success (every topic):** Thanks, we've got it. We'll reply by email. (One message for every topic, so a privacy
    request is never told it joined a waitlist.)
  
  - **Error (validation, from the server):** Something in the form needs fixing. Check the highlighted fields.
  - **Error (network or server):** We couldn't send that. Check your connection and try again.
  - **Too many attempts:** Too many attempts. Wait a minute, then try again.
  - **Unavailable (form disabled, for example before the backend exists):** The form isn't available right now.
    Email us at `{WEB_CONTACT_EMAIL}` (only when set; no default) instead.
    <!-- domain pending owner: logbird.dev isn't bought yet; see README.md § Pending owner decisions -->
- **visual:** none

## other-channels

- **id:** `other-channels`
- **eyebrow:** Elsewhere
- **heading:** Other ways to reach us.
- **bullets:**
  - **Security issues:** don't use this form. See `/security#reporting`.
  - **Source and issues:** Source on GitHub — coming soon.
- **visual:** none
