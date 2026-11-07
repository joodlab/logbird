# @logbird/web — the marketing site

TanStack Start, every page prerendered to static HTML, packaged for Cloudflare Workers with static assets. It reuses
`@logbird/ui` (tokens, theme, highlighter). Copy lives in `marketing/copy/`; change wording there first.

## Commands

Node 22.18+, pnpm 10.30.3. Port **4620** only (marketing range 4620–4629 on the shared machine). Before a build or a
browser run, check ≥ 8 GB free RAM, ≥ 40 GB free on C:, and that no `quiet` slot is held (`C:/Users/raedb/.t3/logbird-locks/RULES.md`).

```sh
pnpm --filter @logbird/web typecheck
pnpm --filter @logbird/web test
pnpm --filter @logbird/web build              # media + OG + prerender + pre-compressed HTML (Node preset)
pnpm --filter @logbird/web serve:static       # serves .output/public like Cloudflare (compression, real 404) on 4620
pnpm --filter @logbird/web start              # the Node server (needed for /api/waitlist) on 4620
pnpm --filter @logbird/web build:cloudflare   # the public build; refuses interim media or localhost URLs
```

Stop the server's whole process tree when done. Never start the console or its services for the site.

## Pages and release gates

`src/lib/site-map.ts` owns routes, titles, descriptions, OG slugs, nav and footer. Each entry has `ready`:

- `ready: false` pages render a placeholder, are `noindex`, and stay out of the nav, footer, sitemap and `llms.txt`.
  Internal `ButtonLink`s to them render nothing. Each page PR flips its own flag.
- `src/lib/release.ts` closes the whole site while any media entry is `interim`: every page is `noindex`, `robots.txt`
  is `Disallow: /`, and `build:cloudflare` fails unless `LOGBIRD_WEB_ALLOW_INTERIM=1` (local previews only).

## Configuration

Only `WEB_*` variables reach the site (`src/env.ts` lists them; Turbo hashes them in `apps/web/turbo.json`), so the
console's `APP_URL` in the root `.env` can't leak in. `src/env.ts` is the only file allowed to contain the provisional
domain, and no site source may contain the company or design-partner names (tests enforce both).

| Variable | Meaning | Default |
| --- | --- | --- |
| `WEB_SITE_URL` | Canonical origin (canonicals, sitemap, OG, JSON-LD, form origin) | provisional domain, pending owner |
| `WEB_APP_URL` | Console sign-in; unset hides "Sign in" | unset (Cloud is waitlist-only) |
| `WEB_GITHUB_PUBLIC`, `WEB_GITHUB_URL` | Repository link and self-host quickstarts | false / unset |
| `WEB_ORG_NAME` | © holder and JSON-LD Organization (pending owner) | unset → "Logbird contributors", no Organization |
| `SMTP_*`, `MAIL_FROM`, `WAITLIST_NOTIFY_TO` | Server-only waitlist notification (Mailpit locally) | — |
| `WAITLIST_FILE` | Node adapter's JSONL file | `apps/web/.data/waitlist.jsonl` when run from `apps/web` |
| `WEB_ALLOWED_ORIGINS` | Extra origins allowed to post the form | — |

A `cloudflare-module` build fails if any public URL is localhost.

## Waitlist

`POST /api/waitlist` takes JSON or a URL-encoded form: zod validation, 8 KB streaming cap, honeypot, origin allowlist
(the site's origin, `WEB_ALLOWED_ORIGINS`, and the request origin in local development), five requests per client per
minute (per process / per isolate, with a bounded client table). Native form posts redirect to
`/contact?status=<code>#waitlist-<code>`, and a `:target` message for that exact code shows without JavaScript.

- Node: appends to the JSONL file (gitignored, mode 600) and emails `WAITLIST_NOTIFY_TO` when `SMTP_HOST` is set.
- Cloudflare: `503 waitlist_unavailable` (the form shows a mailto) until a `WAITLIST_KV` binding exists. Add a
  Cloudflare Rate Limiting rule before enabling it.

## Media

`src/lib/media-manifest.ts` lists real console captures from `marketing/captures/2026-11-07-site-console/` (fictional
"QA Azure Hotels" workspace). `scripts/media.ts` encodes AVIF/WebP (640/1024/1600 px, and phone variants at 390 px)
into `public/media` (ignored). `<Screenshot>` renders one lazy `<picture>` per theme; the pre-paint theme class hides the
other, so only one image downloads and nothing swaps after hydration. Below 640 px an entry's phone capture replaces the
shrunken desktop one. Run `git lfs pull` if a source is a pointer.

OG cards (`scripts/og.ts`, Satori + Resvg, local fonts) render one 1200×630 PNG per manifest slug into `public/og`.

## Verification tools

- `scripts/lighthouse.mjs` runs Lighthouse on demand through `npx` (not a dependency) against Playwright's bundled
  Chromium, mobile and desktop, median of `RUNS` (3). Serve the static build first. `PATHS`, `OUT_DIR`, `--no-fail`.
- `scripts/capture.mjs` takes 1440×900 and 390×844 stills in both themes (`PATHS`, `OUT_DIR`, `VIDEO=1` for scroll clips)
  with Playwright's bundled Chromium only, and fails on console errors or failed requests.

## Cloudflare (manual, no CI)

```sh
pnpm --filter @logbird/web build:cloudflare
cd apps/web && npx wrangler deploy --config wrangler.jsonc
```

The wrapper prerenders with the Node preset, checks every hashed asset the HTML references, then packages the Worker.
`_headers` sets the CSP, nosniff, referrer policy, HSTS (no `includeSubDomains` until the domain is decided) and a
restrictive permissions policy; hashed assets and `/media/*` are immutable for a year.
