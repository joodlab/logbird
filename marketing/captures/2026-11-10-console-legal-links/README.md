# Console sign-in: terms and privacy links (#133)

Captured 2026-11-10 from a local production build of the console (`apps/app/.output/server/index.mjs` on
127.0.0.1:4629), started with `LOGBIRD_SITE_URL=http://127.0.0.1:4628`. That is the hosted setup. With no explicit
`LOGBIRD_TERMS_URL`/`LOGBIRD_PRIVACY_URL`, the links default to the site's `/legal/terms` and `/legal/privacy`. The
site itself wasn't running: the links are only shown, not followed.

No API was running. A capture-only stub on 127.0.0.1:4627 (`LOGBIRD_SERVER_URL`) answered
`GET /api/auth/get-session` with `200 null`, which is better-auth's real signed-out response. It answered nothing
else, and nothing else was requested. Without it the route shows its "could not check" state, because a 5xx from
get-session isn't treated as signed out.

- Stills: `pnpm --filter @logbird/web capture` with `PATHS=/login` (Playwright's bundled Chromium, isolated context,
  fails on console errors or failed requests; it passed) at 1440×900 and 390×844, light and dark.
- Videos: a short Playwright recording (desktop light, phone dark).
  - It types a fictional address (`jane.doe@example.test`), hovers both links and tabs through them to show focus.
  - It asserted both links: Terms → `/legal/terms`, `target="_blank"`, `rel="noreferrer"`; Privacy policy →
    `/legal/privacy`.

Both servers were stopped afterwards, no listener remained on 4627/4629, and the console build was deleted. No real
data is shown.
