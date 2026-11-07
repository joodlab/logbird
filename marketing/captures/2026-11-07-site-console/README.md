# Console captures for the marketing site (2026-11-07)

Real console at `origin/master` 81b0188 on the shared local services, in a fictional workspace **QA Azure Hotels**
(project "Azure Hotels", user "Maya Farouk" with an `@example.test` address). 30,000 fictional events from
`@logbird/seed` were sent through the public ingest API with an ingest key that was revoked afterwards; the seed's
`source` values were rewritten to neutral names (see issue #78). The explorer's query timer was removed from the page
before each still (the site makes no performance claims). Playwright's bundled Chromium, 1440×900 and 390×844.
The project and workspace were deleted after the session.

The first-event onboarding stills were discarded: the page's curl snippet prints the full (since revoked) ingest key.
No key or secret appears in any file here.
