# @logbird/app — the Logbird console

TanStack Start (React 19) on **:4600**. Every route renders in the browser (`defaultSsr: false` in
`src/start.ts`); the Start/Nitro server only ships the shell and proxies `/api` + `/v1` (plus the health checks and the
read-only `/docs` + `/openapi.json`; see `server/proxy-paths.ts`) to the Hono server, in dev and production alike
(`http://127.0.0.1:4601`, override with `LOGBIRD_SERVER_URL`), so the better-auth cookie stays first-party.
The console always talks to a real `apps/server` — run `pnpm dev` at the repo root to start server, worker and app.

```bash
pnpm dev                                    # repo root: server :4601, worker, app :4600
pnpm --filter @logbird/app dev            # app only (expects a server on :4601)
pnpm --filter @logbird/app build && pnpm --filter @logbird/app start
```

## Layout

| Path | What lives there |
| --- | --- |
| `src/lib/api/client.ts` | Typed API client — same-origin `fetch`, every response parsed with `@logbird/contracts`, errors mapped from `apiErrorSchema`. |
| `src/lib/api/queries.ts` | `queryOptions` / `infiniteQueryOptions` factories (keys: `['projects', projectId, resource, …]`). |
| `src/lib/auth-client.ts` | better-auth client (`emailOTPClient` + `organizationClient`). |
| `src/lib/query-language.ts` | Lossless tokenizer for the query bar (highlighting, autocomplete, facet include/exclude). |
| `src/lib/snippets.ts` | SDK / curl snippets — runnable as copied (real key when one was just created, `$LOGBIRD_*_KEY` otherwise). |
| `src/components/explorer/*` | Query bar, facets, histogram, virtualized table (Table v9 + Virtual), event sheet. |
| `src/components/timestamp.tsx` | Every time is shown in local time; the tooltip adds UTC and relative time. |
| `src/routes/*` | File routes. Explorer state lives in search params (`q`, `range`, `cols`, `ev`, `live`, `view`). |

## QA and media

Both scripts drive the real stack with Playwright (`npx playwright install chromium` once). Sign-in codes are
read from Mailpit's API (`http://127.0.0.1:8025`).

```bash
node scripts/qa-shoot.mjs login demo@logbird.local            # saves a session to .qa-state.json
node scripts/qa-shoot.mjs shoot ./out dark 1440x900 /p/<id>/events  # screenshots + console/HTTP problems
node apps/app/scripts/capture-media.mjs # from repo root; see docs/media/README.md
```

## Hosted marketing routes

`LOGBIRD_SITE_URL` optionally points at the private marketing Node server (for
example `http://logbird-site:4620`). The console remains the public origin; API,
auth and invitation routes keep their existing forwarding and cookie behavior.
Marketing pages and `/site-assets/`, `/site-api/`, `/media/`, `/og/` go to the site
without credentials. Anonymous `/` requests see marketing; either non-empty
Logbird session cookie keeps `/` on the console. If the site fails, only `/`
falls back to the console; elsewhere the site's own responses (errors included) pass
through, and only an unreachable site becomes 502. Leave the variable empty
for the existing self-hosted behavior. See [Coolify](../../docs/coolify.md).
