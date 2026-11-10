# Privacy policy, terms and the form's privacy line

Captured 2026-11-10 (retaken after the review fixes, at the text of this commit) from a local production build of the site (`apps/web/.output/server/index.mjs` on 127.0.0.1:4628),
built with `WEB_SITE_URL=WEB_APP_URL=https://logbird.joodlab.com`, `WEB_GITHUB_PUBLIC=true` and the owner facts
(`WEB_ORG_NAME`, `WEB_PRIVACY_EMAIL`, `WEB_LEGAL_ADDRESS`, `WEB_GOVERNING_LAW`, `WEB_HOSTING_PROVIDER`,
`WEB_EMAIL_PROVIDER`) unset. That is what ships until the owner provides them: neutral wording, and privacy requests via
the form's "A privacy request" topic.

Stills: `pnpm --filter @logbird/web capture` (Playwright's bundled Chromium, isolated context, fails on console errors or
failed requests) at 1440×900 and 390×844, light and dark. Video: the same script with `VIDEO=1`. `check:live` passed for
all 37 responses. The server was stopped afterwards; no listener remained on 4628. No real data is shown.
