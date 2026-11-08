# @logbird/web — the marketing site

TanStack Start, every page prerendered to static HTML, packaged for Cloudflare Workers with static assets. It reuses
`@logbird/ui` (tokens, theme, highlighter). Copy lives in `marketing/copy/`; change wording there first.

## Commands

Node 22.18+, pnpm 10.30.3. Port **4620** only (marketing range 4620–4629 on the shared machine). Before a build or a
browser run, check ≥ 8 GB free RAM, ≥ 40 GB free on C:, and that no `quiet` slot is held (`C:/Users/raedb/.t3/logbird-locks/RULES.md`).

```sh
pnpm --filter @logbird/web typecheck
pnpm --filter @logbird/web test
pnpm --filter @logbird/web build              # media + OG + prerender + pre-compressed HTML + CSP hashes (Node preset)
pnpm --filter @logbird/web serve:static       # serves .output/public like Cloudflare (compression, real 404) on 4620
pnpm --filter @logbird/web check:source-state  # after a build: fails if a public build says the source is closed, or a private one says it's open
pnpm --filter @logbird/web start              # the Node server (needed for /api/waitlist) on 4620
pnpm --filter @logbird/web build:cloudflare   # the public build; refuses interim media or localhost URLs
```

Stop the server's whole process tree when done. Never start the console or its services for the site.

## Pages and release gates

`src/lib/site-map.ts` owns routes, titles, descriptions, OG slugs, nav and footer. Each entry has `ready`:

- `ready: false` pages render a placeholder, are `noindex`, and stay out of the nav, footer, sitemap and `llms.txt`.
  Internal `ButtonLink`s to them render nothing. Each page PR flips its own flag.
- `src/lib/release.ts` closes the whole site while any media entry is `interim`, `WEB_SITE_URL` is unset (provisional
  domain), `WEB_SECURITY_EMAIL` or `WEB_CONTACT_EMAIL` is unset (no mailbox is ever derived from the provisional domain),
  or `/legal/privacy` or `/legal/terms` is still a placeholder (`ready: false`): every page is `noindex`, `robots.txt`
  is `Disallow: /`, and `build:cloudflare` fails unless `LOGBIRD_WEB_ALLOW_INTERIM=1` (local previews only).

## Configuration

Only `WEB_*` variables reach the site (`src/env.ts` lists them; Turbo hashes them and every env file the loader reads, root `.env*` and `apps/web/.env*`, in `apps/web/turbo.json`, and a test keeps the list complete), so the
console's `APP_URL` in the root `.env` can't leak in. `scripts/public-env.ts` resolves them once per build (root `.env*`,
then `apps/web/.env*`, then the process environment) and the bundle, sitemap, robots, `llms.txt` and OG cards all use
that one result, so their origins always agree. `src/env.ts` is the only file allowed to contain the provisional
domain, and no site source may contain the company or design-partner names (tests enforce both).

| Variable | Meaning | Default |
| --- | --- | --- |
| `WEB_SITE_URL` | Canonical origin (canonicals, sitemap, OG, JSON-LD, form origin) | provisional domain, pending owner |
| `WEB_APP_URL` | Console sign-in; unset hides "Sign in" | unset (Cloud is waitlist-only) |
| `WEB_GITHUB_PUBLIC`, `WEB_GITHUB_URL` | Repository link and self-host quickstarts | false / unset |
| `WEB_ORG_NAME` | © holder and JSON-LD Organization (pending owner) | unset → "Logbird contributors", no Organization |
| `WEB_SECURITY_EMAIL` | Vulnerability-report mailbox. **No default**: unset renders `SECURITY.md`'s "ask the maintainers for a private channel" wording | unset (release blocker) |
| `WEB_CONTACT_EMAIL` | General contact mailbox. **No default**: unset, the form's messages name no address | unset (release blocker) |
| `SMTP_*`, `MAIL_FROM`, `WAITLIST_NOTIFY_TO` | Server-only waitlist notification (Mailpit locally). `MAIL_FROM` and `WAITLIST_NOTIFY_TO` have **no defaults**: with SMTP on and either missing, notifications are off (one `waitlist.notify_disabled` warning, no personal data) and submissions are still stored | — |
| `WAITLIST_FILE` | Node adapter's JSONL file | `apps/web/.data/waitlist.jsonl` when run from `apps/web` |
| `WEB_TRUST_PROXY` | Reverse proxies in front of the Node server that append to `X-Forwarded-For`; the client is that many entries from the right. 0 (default) ignores forwarding headers, so behind an untrusted or unset proxy every visitor shares one limiter bucket: set this, or enforce the per-client limit at the proxy | 0 |
| `WEB_ALLOWED_ORIGINS` | Extra origins allowed to post the form (set `http://127.0.0.1:4620` for a local `pnpm start`, which runs as production) | — |

A `cloudflare-module` build fails if any public URL is localhost.

## Waitlist

`POST /api/waitlist` takes JSON or a URL-encoded form: zod validation, 8 KB streaming cap, honeypot, origin allowlist
(the site's origin, `WEB_ALLOWED_ORIGINS`, and the request origin in local development), five requests per client per
minute (per process / per isolate, with a bounded client table). Native form posts redirect to
`/contact?status=<code>#waitlist-<code>`, and a `:target` message for that exact code shows without JavaScript.

- Node: appends to the JSONL file (gitignored, created with mode 600) and answers success as soon as it's written. When
  `SMTP_HOST` is set it then emails `WAITLIST_NOTIFY_TO` in the background, retrying with backoff; a final failure logs
  `waitlist.notify_failed` with no personal data (the record stays in the file). The root `.dockerignore` keeps
  `**/.data` and `waitlist*.jsonl` out of every Docker build context.
- Cloudflare: `503 waitlist_unavailable` (the form shows a mailto) until a `WAITLIST_KV` binding exists. Add a
  Cloudflare Rate Limiting rule before enabling it.

## Media

`src/lib/media-manifest.ts` lists real console captures from `marketing/captures/2026-11-07-site-console/` (fictional
"QA Azure Hotels" workspace). `scripts/media.ts` encodes AVIF/WebP (640/1024/1600 px, and phone variants at 390 px)
into `public/media` (ignored). `<Screenshot>` renders one lazy `<picture>` per theme; the pre-paint theme class hides the
other, so only one image downloads and nothing swaps after hydration. Below 640 px an entry's phone capture replaces the
shrunken desktop one. Run `git lfs pull` if a source is a pointer. Turbo hashes `marketing/captures/**` for this
package's build, so replacing a capture rebuilds the media. Media URLs are stable (not content-hashed), so `/media/*`
is cached for a day with stale-while-revalidate, never `immutable`.

OG cards (`scripts/og.ts`, Satori + Resvg, local fonts) render one 1200×630 PNG per manifest slug into `public/og`.

## Verification tools

- `scripts/lighthouse.mjs` runs Lighthouse on demand through `npx` (not a dependency) against Playwright's bundled
  Chromium, mobile and desktop, median of `RUNS` (3). Serve the static build first. `PATHS`, `OUT_DIR`, `--no-fail`.
  While the served `robots.txt` disallows crawling (a release blocker is open, so every page is noindex by design), the
  SEO pass mark (95) is the score without the `is-crawlable` audit (`seo-content`). Once `robots.txt` allows crawling,
  ready pages and published posts are held to the full SEO score, `is-crawlable` included, so an accidental `noindex`
  fails; pages that stay noindex (unready pages, 404) keep `seo-content` (`src/lib/lighthouse-score.ts`).
- `check:source-state` matches its phrase lists (`src/lib/source-state.ts`) case-insensitively on each page's visible
  text (tags dropped, entities decoded, plus meta descriptions, alt text and labels), so a claim split by markup still
  counts. The public link label "Source on GitHub" counts as "open" unless the placeholder's "— coming soon" follows it.
  Quotation marks exempt nothing; only text marked `data-third-party-quote` is left out, and only comparison pages set
  it (`<Rich thirdPartyQuotes>` on the competitor column and sources, for quotes from that product's docs).
- `scripts/capture.mjs` takes 1440×900 and 390×844 stills in both themes (`PATHS`, `OUT_DIR`, `VIDEO=1` for scroll clips)
  with Playwright's bundled Chromium only, and fails on console errors or failed requests.

## Cloudflare (manual, no CI)

```sh
pnpm --filter @logbird/web build:cloudflare
cd apps/web && npx wrangler deploy --config wrangler.jsonc
```

The wrapper prerenders with the Node preset, checks every hashed asset the HTML references, then packages the Worker.
`_headers` sets the CSP, nosniff, referrer policy, HSTS (no `includeSubDomains` until the domain is decided) and a
restrictive permissions policy. Hashed `/assets/*` are immutable for a year; `/media/*` for a day.

### Content-Security-Policy

`script-src` has no `'unsafe-inline'`. Every page is prerendered, so `scripts/csp.ts` (the last step of `build` and
`build:cloudflare`) hashes each page's inline scripts (theme bootstrap, JSON-LD, TanStack Start's hydration data, which
changes with every build) and writes:

- `.output/public/_headers`: a `/*` rule with the shared headers and the 404 page's policy (Cloudflare serves 404.html
  for unknown paths), then one rule per page that detaches that policy (`! Content-Security-Policy`) and sets its own.
  Without the detach Cloudflare would comma-join two policies and enforce both. Page rules use the trailing-slash URLs
  of `html_handling: "auto-trailing-slash"`; a test keeps `wrangler.jsonc` on that setting. Cloudflare allows 100 rules
  and 2,000-character lines, and the build fails past either (one rule per page: about 95 pages and posts fit).
- `.output/csp.json`: the same hashes for `pnpm start` and `pnpm serve:static`. Like Cloudflare, `server/static-pages.ts`
  serves each prerendered page with its policy, existing public files and `/api/*` through Nitro, and 404.html (status
  404, the 404 policy) for every other path, dotted ones (`/x.js`, `/post.md`) included. Nothing is rendered on demand.

One file serves many URLs (contact/index.html for `?status=` and `?interest=`, 404.html for every unknown path), so
the page rendered at each of those URLs must equal the file the browser hydrates. The waitlist form applies `status`
and `interest` after mount, the `/404` route has no head of its own, and no nav or footer link is current on a
not-found page; `src/lib/hydration.test.ts` compares the renders.

The step then re-reads the final HTML and fails the build if any inline script isn't covered by the policy each target
serves. `vite dev` renders on demand and injects HMR scripts, so only the dev server keeps `'unsafe-inline'`.
`style-src 'unsafe-inline'` stays until the runtime styles are reviewed separately.
