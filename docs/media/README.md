# Public demo media

Captured on 2026-11-09 from the real local console and API against Postgres, ClickHouse, Dragonfly and Mailpit. No mocked responses or production systems. The additive capture fixture creates a new Acme workspace with StayDesk (18,000 events) and Ledger demo (1,000 events), using the `staydesk` seed profile spread over seven days. Each run has a distinct workspace slug and a fictional `example.com` login named Demo operator; no existing workspace is reset.

`marketing/media/staydesk/` contains 19 WebP stills at 1440?900 (desktop) and 390?844 (phone), including light/dark explorer, overview, changes, SQL and phone views. `walkthrough.gif` and `walkthrough.webm` contain the same short journey: real email OTP sign-in, overview, explorer search, event detail with a changes diff, and live tail receiving three newly ingested fictional bookings. The original Playwright recording remains ignored under `.tmp/`.

## Reproduce

Install Node 22.18+, pnpm 10.30.3 and ffmpeg. Follow [CONTRIBUTING](../../CONTRIBUTING.md) to configure `.env`, migrate your local services and start the API and console. Mailpit must be available at `http://127.0.0.1:8025`. In a second terminal, from the repository root:

```sh
pnpm --filter @logbird/app exec playwright install chromium
node --env-file=.env --import tsx apps/app/scripts/prepare-media.ts
node apps/app/scripts/capture-media.mjs
CAPTURE_VIDEO=1 node apps/app/scripts/capture-media.mjs
node apps/app/scripts/encode-media.mjs
pnpm --filter @logbird/web test
pnpm --filter @logbird/web build
```

On PowerShell, set `$env:CAPTURE_VIDEO='1'` before the video command, then remove it with `Remove-Item Env:CAPTURE_VIDEO`. `BASE_URL`, `MAILPIT_API`, `OUT_DIR` and `FFMPEG` may override local endpoints, screenshot output and the encoder executable. Capture state in `.tmp/media-fixture.json` contains a private fixture ingest key: never print or commit it. The capture browser always closes in `finally`. Stop all servers/workers you started; leave shared backing services and other contributors' fixtures intact.

## Encoding and review

The encoding script scales to 1200 px, trims browser startup (override `VIDEO_START` after reviewing a new recording) and plays the journey at 1.2?, uses a 12 fps / 128-color `palettegen` + `paletteuse` GIF, removes video metadata, and refuses a GIF over 6,000,000 bytes. Inspect the complete animation and all stills after every recapture. Confirm that the changes diff is visible, live events really arrive, all identities are fictional, and no keys, personal paths or real email addresses appear. The rejected-SQL still intentionally exercises a 422 validation response; other API and console errors fail capture.

This curated set is roughly 8 MB combined. It is stored as ordinary Git blobs, including the GIF, so GitHub renders the README and clean clones can build the site without Git LFS. Do not add raw recordings or bulk QA output. The manifest and Turbo inputs cover both media directories; tests check source bytes and the GIF budget, and the site build checks image dimensions.
