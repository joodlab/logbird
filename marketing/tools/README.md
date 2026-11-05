# Capture tools

- `apps/app/scripts/walkthrough.mjs` — the recorded walkthrough (Playwright). Signs in with a real OTP from Mailpit,
  drives every flow, writes PNG stills + webm clips, and fails on console/API errors.
  `OUT_DIR=marketing/captures/<date>-<topic> [STEPS=tour,query-bar,onboarding,setup,invite] [BASE_URL=…] node apps/app/scripts/walkthrough.mjs`
- `apps/app/scripts/capture-media.mjs`, `capture-final-polish.mjs` — older targeted capture scripts.
