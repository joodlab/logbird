# Cloud origin: marketing site behind the console (PR #126)

Captured 2026-11-10 from local production builds, through the **console** origin, as visitors of
logbird.joodlab.com will see it:

- site: `apps/web/.output/server/index.mjs` on 127.0.0.1:4628, built with `WEB_SITE_URL=WEB_APP_URL=https://logbird.joodlab.com`,
  `WEB_GITHUB_PUBLIC=true`, `WEB_GITHUB_URL=https://github.com/joodlab/logbird` (release list fetched live from GitHub);
- console: `apps/app/.output/server/index.mjs` on 127.0.0.1:4629 with `LOGBIRD_SITE_URL=http://127.0.0.1:4628` and no API
  running (API paths answer 502 by design here).

Stills: `pnpm --filter @logbird/web capture` (Playwright's bundled Chromium, isolated context, fails on console errors or
failed requests) at 1440×900 and 390×844, light and dark. Videos: the same script with `VIDEO=1`.
`proxy-proof.txt`: the console→site routing checks (21 passed). `check:live` against the site passed for all 37 responses.
Both servers were stopped afterwards and no listener remained on 4628/4629. No real data is shown.
