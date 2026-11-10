# @logbird/web — the marketing site

TanStack Start, every page prerendered to static HTML, packaged for Cloudflare Workers with static assets. It reuses
`@logbird/ui` (tokens, theme, highlighter). Copy lives in `marketing/copy/`; change wording there first.

## Commands

Use Node 22.18+ and pnpm 10.30.3. The development server uses port **4620**.
Keep machine-specific resource limits and coordination rules in gitignored `AGENTS.local.md`.

```sh
pnpm --filter @logbird/web typecheck
pnpm --filter @logbird/web test
pnpm --filter @logbird/web build              # media + OG + prerender + pre-compressed HTML + CSP hashes (Node preset)
pnpm --filter @logbird/web serve:static       # serves .output/public like Cloudflare (compression, real 404) on 4620
pnpm --filter @logbird/web check:source-state  # after a build: fails if a public build says the source is closed, or a private one says it's open or links to it
BASE_URL=http://127.0.0.1:4620 pnpm --filter @logbird/web check:live  # against a running site: every HTML response's CSP covers its own inline scripts
SHARED_ORIGIN=1 BASE_URL=http://127.0.0.1:4629 pnpm --filter @logbird/web check:live  # through a console with LOGBIRD_SITE_URL: site paths only, console paths stay the console's
pnpm --filter @logbird/web start              # the Node server (needed for /site-api/waitlist) on 4620
pnpm --filter @logbird/web build:cloudflare   # the public build; refuses interim media or localhost URLs
```

Stop the server's whole process tree when done. Never start the console or its services for the site.

## Pages and release gates

`src/lib/site-map.ts` owns routes, titles, descriptions, OG slugs, nav and footer. Each entry has `ready`:

- `ready: false` pages render a placeholder, are `noindex`, and stay out of the nav, footer, sitemap and `llms.txt`.
  Internal `ButtonLink`s to them render nothing. Each page PR flips its own flag.
- `src/lib/release.ts` closes the whole site while any media entry is `interim`, `WEB_SITE_URL` is unset (provisional
  domain), `WEB_SECURITY_EMAIL` or `WEB_CONTACT_EMAIL` is unset (no mailbox is ever derived from the provisional domain),
  `WEB_ORG_NAME` or `WEB_PRIVACY_EMAIL` is unset (the privacy policy must name who is responsible and how to reach them), or
  `/legal/privacy` or `/legal/terms` is taken back to `ready: false`: every page is `noindex`, `robots.txt`
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
| `WEB_PRIVACY_EMAIL` | Privacy-request mailbox named in the privacy policy. **No default**: unset, the policy points to the form's "A privacy request" topic | unset (release blocker) |
| `WEB_LEGAL_ADDRESS`, `WEB_GOVERNING_LAW` | The operator's postal address and the terms' governing-law clause (e.g. "the laws of <country>") | unset → omitted / neutral wording (pending owner) |
| `WEB_HOSTING_PROVIDER`, `WEB_EMAIL_PROVIDER` | Server provider (and region) and email delivery provider named in the privacy policy | unset → "our server provider" (pending owner) / Postmark (Logbird Cloud's provider) |
| `WEB_MAILBOX_PROVIDER` | Host of the team mailbox that receives form submissions and emails, named in the privacy policy | unset → "our mailbox provider" (pending owner) |
| `WEB_FORM_RETENTION_MONTHS` | Calendar months the site keeps a form submission: the privacy policy states it and the cleanup applies it (docs/coolify.md, "Form submissions") | 24 (1–120) |
| `SMTP_*`, `MAIL_FROM`, `WAITLIST_NOTIFY_TO` | Server-only waitlist notification (Mailpit locally). `MAIL_FROM` and `WAITLIST_NOTIFY_TO` have **no defaults**: with SMTP on and either missing, notifications are off (one `waitlist.notify_disabled` warning, no personal data) and submissions are still stored | — |
| `WAITLIST_FILE` | Node adapter's JSONL file; when set, the production server also deletes expired submissions from it | `apps/web/.data/waitlist.jsonl` when run from `apps/web` (no cleanup) |
| `WEB_TRUST_PROXY` | Reverse proxies in front of the Node server that append to `X-Forwarded-For`; the client is that many entries from the right. 0 (default) ignores forwarding headers, so behind an untrusted or unset proxy every visitor shares one limiter bucket: set this, or enforce the per-client limit at the proxy | 0 |
| `WEB_ALLOWED_ORIGINS` | Extra origins allowed to post the form (set `http://127.0.0.1:4620` for a local `pnpm start`, which runs as production) | — |

A `cloudflare-module` build fails if any public URL is localhost.

## Waitlist

`POST /site-api/waitlist` takes JSON or a URL-encoded form: zod validation, 8 KB streaming cap, honeypot, origin allowlist
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

`src/lib/media-manifest.ts` lists real console captures from `marketing/media/staydesk/` (fictional
Acme workspace and StayDesk project). `scripts/media.ts` encodes AVIF/WebP (640/1024/1600 px, and phone variants at 390 px)
into `public/media` (ignored). `<Screenshot>` renders one lazy `<picture>` per theme; the pre-paint theme class hides the
other, so only one image downloads and nothing swaps after hydration. Below 640 px an entry's phone capture replaces the
shrunken desktop one. Sources are compact WebP files in normal Git. Turbo hashes `marketing/media/**` for this
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
- `check:source-state` matches its phrase lists (`src/lib/source-state.ts`) case-insensitively, one text unit at a
  time, in two passes; a phrase counts if either pass finds it. Paragraphs, list items, headings, cells and attribute
  values are always separate units, so no match runs from one into the next, and inline markup (`<b>`, `<em>`,
  `<span>`…) never splits a sentence. The first pass also ends a unit at every link or button, so a leaked "Source on
  GitHub" link label is caught even when unrelated text after it reads "— coming soon"; the second joins inline links
  into their sentence, so a claim whose key word is a link (`<a>Self-host</a> it`, `We have <a>released</a> the
  source`, `coming <a>soon</a>`) is caught. Entities are decoded and typographic apostrophes and quotes normalized.
  Quotation marks exempt nothing; only text marked `data-third-party-quote` is left out, and only comparison pages set
  it (`<Rich thirdPartyQuotes>` on the competitor column and sources, for quotes from that product's docs). With
  `WEB_GITHUB_URL` set, a private build also fails on any reference to the repository: a link under any label, `src`,
  `action`, meta and JSON-LD values, code blocks and plain text, in any form (`https:`, `http:`, `//`, `www.`, bare
  host, `.git`, any case).
- `check:live` fetches every page and a set of unknown, dotted, escaped and API paths from `BASE_URL`, and fails unless
  each HTML response carries one CSP without `'unsafe-inline'` that covers that body's inline scripts, plus nosniff,
  HSTS, referrer and permissions policies. Unknown paths, including case variants of real files and pages
  (`/ROBOTS.TXT`, `/About/index.html`), must be the 404 page; the only redirect allowed is the documented Cloudflare
  one below, and only to `/about/`. Unknown `/site-api/*` paths must be a JSON 404 (`NO_API=1` for `serve:static`), and a
  POST to a page path an empty 405. Run it against `pnpm start`, `pnpm serve:static`, `wrangler dev` and a deploy.
- `scripts/capture.mjs` takes 1440×900 and 390×844 stills in both themes (`PATHS`, `OUT_DIR`, `VIDEO=1` for scroll clips)
  with Playwright's bundled Chromium only, and fails on console errors or failed requests.

## Cloudflare (manual, no CI)

```sh
pnpm --filter @logbird/web build:cloudflare
cd apps/web && npx wrangler deploy --config wrangler.jsonc
```

The wrapper prerenders with the Node preset, checks every hashed asset the HTML references, then packages the Worker.
`_headers` sets the CSP, nosniff, referrer policy, HSTS (no `includeSubDomains` until the domain is decided) and a
restrictive permissions policy. Hashed `/site-assets/*` are immutable for a year; `/media/*` for a day.

### Content-Security-Policy

`script-src` has no `'unsafe-inline'`. Every page is prerendered, so `scripts/csp.ts` (the last step of `build` and
`build:cloudflare`) hashes each page's inline scripts (theme bootstrap, JSON-LD, TanStack Start's hydration data, which
changes with every build) and writes:

- `.output/public/_headers`: a `/*` rule with the shared headers and the 404 page's policy (Cloudflare serves 404.html
  for unknown paths), then one rule per page that detaches that policy (`! Content-Security-Policy`) and sets its own.
  Without the detach Cloudflare would comma-join two policies and enforce both. Page rules use the trailing-slash URLs
  of `html_handling: "auto-trailing-slash"`; a test keeps `wrangler.jsonc` on that setting. Cloudflare allows 100 rules
  and 2,000-character lines, and the build fails past either (one rule per page: about 95 pages and posts fit).
- `.output/csp.json`: the same hashes for `pnpm start` and `pnpm serve:static`, which route requests by the same rules
  (`src/lib/page-response.ts`). `server/static-pages.ts` serves each prerendered page with its policy and the other
  security headers; `/site-api/*` goes to Nitro, where every route answers JSON (`/site-api/waitlist`, and a JSON 404 for the
  rest); a build-time public file goes to Nitro's static handler, but only when its canonical path is in the manifest's
  case-exact list of public files (`publicFiles`), the key that handler looks up. The file system is never asked:
  Windows and macOS ignore case, so `/SITE-ASSETS/app.js` would exist there while Nitro has no such asset. Every other
  GET/HEAD is 404.html with status 404 and the 404 policy: unknown and dotted paths, case variants, escaped separators
  (`%2F`, `%5C`), `.`/`..` segments, `//`, and files written after Nitro listed its assets (`*.br`, `*.gz`, `_headers`).
  Other methods outside `/site-api/` get 405 (`server/method-guard.ts`, on every preset). So no page or 404 is rendered on
  demand.

On Cloudflare, `run_worker_first` sends only `/site-api/*` to the Worker; the static asset router answers everything else,
with `not_found_handling: "404-page"` serving 404.html under the `/*` rule. Checked locally with
`npx wrangler@4.152.0 dev --config wrangler.jsonc --local --port 4621` on a `build:cloudflare` output (2026-11-08):
`check:live` passes for all 37 responses. Unknown, dotted, escaped and case-variant paths get the static 404 with its
hashed policy (the asset router is case-sensitive), none reaches the Worker, and unknown `/site-api/*` paths get the JSON
404. A POST, PUT or DELETE to a page path gets an empty 405 from the asset router itself, before the Worker;
`server/method-guard.ts` is the Worker's own guard should that routing change. One difference from the Node server:
Cloudflare decodes `%2F` and redirects `/x%2f..%2fabout%2findex.html` to `/about/`, the static About page with its own
policy. Run `check:live` against the real deployment before indexing.

One file serves many URLs (contact/index.html for `?status=` and `?interest=`, 404.html for every unknown path), so
the page rendered at each of those URLs must equal the file the browser hydrates. The waitlist form applies `status`
and `interest` after mount, the `/404` route has no head of its own, and no nav or footer link is current on a
not-found page; `src/lib/hydration.test.ts` compares the renders.

The step then re-reads the final HTML and fails the build if any inline script isn't covered by the policy each target
serves. `vite dev` renders on demand and injects HMR scripts, so only the dev server keeps `'unsafe-inline'`.
`style-src 'unsafe-inline'` stays until the runtime styles are reviewed separately.

## Node container

`apps/web/Dockerfile` builds the Node preset, including media, OG cards and
`.output/csp.json`. All public `WEB_*` values (`PUBLIC_ENV_KEYS` in `src/env.ts`) are build arguments; changing
them requires a rebuild. Fonts come from installed packages; media comes from
`marketing/media` (materialized Git LFS files), with no build-time font download.
The runtime runs as `node` on port 4620 and appends waitlist entries under `/data`.
Empty `WEB_APP_URL`, `WEB_ORG_NAME`, `WEB_SECURITY_EMAIL` and `WEB_CONTACT_EMAIL`
build arguments keep the documented unset behavior.

Use `docker-compose.site.yml` as a separate private Coolify resource; see
[Coolify](../../docs/coolify.md#hosted-marketing-site-logbirdjoodlabcom-only).
The console forwards marketing pages when `LOGBIRD_SITE_URL` is set. The site's
`/site-api/` and hashed `/site-assets/` namespaces avoid the console's `/api/` and
`/assets/`. Shared `/brand/` files stay on the console and must remain identical.
