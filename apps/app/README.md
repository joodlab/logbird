# @trailmark/app — the Trailmark console

TanStack Start (React 19) on **:4600**. Every route renders in the browser (`defaultSsr: false` in
`src/start.ts`); the Start/Nitro server only ships the shell and proxies `/api` + `/v1` to the Hono server
(`http://127.0.0.1:4601`, override with `TRAILMARK_SERVER_URL`), so the better-auth cookie stays first-party.

```bash
pnpm --filter @trailmark/app dev            # real mode: talks to apps/server through the proxy
pnpm --filter @trailmark/app dev:fixtures   # dev-only fixture mode (no server needed)
pnpm --filter @trailmark/app build && pnpm --filter @trailmark/app start
```

## Layout

| Path | What lives there |
| --- | --- |
| `src/lib/api/transport.ts` | The single network seam (`fetch` in real mode, `src/dev` in fixture mode). |
| `src/lib/api/client.ts` | Typed API client — every response is parsed with `@trailmark/contracts`; errors map from `apiErrorSchema`. |
| `src/lib/api/queries.ts` | `queryOptions` / `infiniteQueryOptions` factories (keys: `['projects', projectId, resource, …]`). |
| `src/lib/auth-client.ts` | better-auth client (`emailOTPClient` + `organizationClient`), same transport. |
| `src/lib/query-language.ts` | Lossless tokenizer for the query bar (highlighting, autocomplete, facet include/exclude). |
| `src/components/explorer/*` | Query bar, facets, histogram, virtualized table (Table v9 + Virtual), event sheet. |
| `src/routes/*` | File routes. Explorer state lives in search params (`q`, `range`, `cols`, `ev`, `live`, `view`). |
| `src/dev/*` | **Dev-only fixtures** — delete the folder to remove them. |

## Fixture mode

`VITE_FIXTURES=1` (or `--mode fixtures`) swaps the transport for an in-browser server that answers the same
URLs with deterministic, StayDesk-shaped data: ~30 hotel businesses, staff, platform admins who impersonate,
API-key and integration actors, workers/schedulers/webhooks, operation trees with retries and failures,
off-standard events, plus a small "Ledger demo" project and the workspace activity stream. New events keep
arriving so live tail and the ingestion card move.

- Sign in as `demo@trailmark.local` for the seeded workspace, or any other email to walk onboarding.
- The one-time code is always `424242` (any other code shows the error state).
- State persists in `localStorage` (`trailmark.fixtures.v1`); the banner's **Reset** button clears it.
- The branch is gated on `import.meta.env.DEV`, so production builds never include it.

## Media

`pnpm --filter @trailmark/app media` (with `dev:fixtures` running) regenerates the screenshots and videos in
`docs/media/ui-foundation/` using Playwright (`npx playwright install chromium` once).
