---
title: Contact Logbird — join the Cloud waitlist
description: Join the Logbird Cloud waitlist or send us a question. We store your email only to contact you about Logbird. No trackers.
path: /contact
---

# Contact

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
  | `email` (required) | Work email | We'll only use it to contact you about Logbird. | Enter a valid email address. |
  | `name` (optional) | Name | | |
  | `company` (optional) | Company | | |
  | `topic` (required, radio) | What's this about? | | Choose one. |
  | `message` (optional; required when topic is "A question") | Message | What are you building, and what do you need from an audit log? | Add a message so we know how to help. |

- **topic options:**
  - `waitlist` — Logbird Cloud waitlist (default)
  - `self-host` — "Self-hosting, when the source opens" (once `WEB_GITHUB_PUBLIC=true`: "Self-hosting")
  - `support` — Support or enterprise
  - `question` — A question
- **placeholder for email:** `you@example.test`
- **submit button:** Send
- **privacy note (under the button):** We store your email to contact you about Logbird. No trackers.
  Privacy policy → `/legal/privacy`
- **visual:** none

## states

- **id:** `states`
- **messages:**
  - **Sending (button label):** Sending…
  - **Success, waitlist:** You're on the list. We'll email you when Logbird Cloud opens.
  - **Success, other topics:** Thanks. We've got your message and will reply by email.
  - **Already on the list:** You're already on the list. We'll email you when Logbird Cloud opens.
  - **Error (validation, from the server):** Something in the form needs fixing. Check the highlighted fields.
  - **Error (network or server):** We couldn't send that. Check your connection and try again.
  - **Too many attempts:** Too many attempts. Wait a minute, then try again.
  - **Unavailable (form disabled, for example before the backend exists):** The form isn't available right now.
    Email us at `hello@logbird.dev` instead.
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
