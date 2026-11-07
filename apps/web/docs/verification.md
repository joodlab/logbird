# Verification — round 2 (2026-11-07)

Machine: shared Windows workstation; every build and browser run started only with ≥ 8 GB free RAM and no `quiet` slot.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | passes; lockfile changes only the `apps/web` importer |
| `pnpm --filter @logbird/web typecheck` / `test` | pass; 27 tests (env, release gate, site map + literal guards, SEO/discovery, waitlist) |
| `pnpm exec biome check apps/web` | no diagnostics |
| `pnpm --filter @logbird/web build` | 20 HTML files (crawler also visits `/contact?interest=self-host`), media + OG + pre-compressed HTML |
| `pnpm --filter @logbird/web build:cloudflare` | passes: no interim media, no localhost public URLs; Worker packaged, every hashed asset verified |
| Static output | `robots.txt` allows and points at the sitemap; sitemap and `llms.txt` list only `/` and `/contact`; unready pages carry `noindex` |
| Lighthouse 13.6.0 via npx, bundled Chromium, median of 3, `serve:static` | `/` and `/contact`: 100/100/100/100 mobile and desktop; `/404`: 100/100/100/66 (noindex by design) |
| Waitlist on `pnpm start` with `WEB_ALLOWED_ORIGINS=http://127.0.0.1:4620` | JSON → 200, JSONL line, Mailpit message; no-JS invalid → 303 `?status=validation_error#waitlist-validation_error`; no-JS ok → 303 `?status=ok#waitlist-ok`; foreign origin → 400. Test messages deleted from Mailpit by ID. |
| Captures | `marketing/captures/2026-11-07-web-home/` (home, contact, 404 in both themes at 1440 and 390, two scroll clips) and `marketing/captures/2026-11-07-site-console/` (console, fictional workspace) |

Every server and browser started for these checks was stopped; port 4620 was free afterwards.
