# Foundation verification — 2026-11-07

Scope: `apps/web/**` and installation-generated `pnpm-lock.yaml`. No PR, merge, deployment, CI workflow, database reset or backing-service startup. Starting revision: `2bce2fad3aca828a4faee7ee29e667153c48130e`.

| Check | Observed result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed; lockfile agrees with package manifests |
| Package typecheck | Passed, including server handlers and scripts |
| Package tests | 21 passed across four files |
| `pnpm check` | Passed; 76 existing warnings outside the owned app |
| Node build | Passed; 20 prerendered HTML targets, including `404.html` |
| Cloudflare build | Passed through the two-phase wrapper; 20 HTML files copied after verifying their asset references |
| Emitted files | All 19 public/draft targets contain an HTML heading; 404 contains noindex; sitemap, robots, llms and home OG exist |
| Media generation | Passed for eight screenshot entries and two clips; all supplied inputs are real binaries, not LFS pointers |
| OG generation | 20 images rendered; 1200×630 home sample visually inspected with the border correction |
| Root typecheck, one sequential run | Blocked before compilation: existing `@logbird/database:setup` requires `DATABASE_URL`, undefined because this worktree lacks the gitignored root `.env` |
| Preview HTTP / unknown-route HTTP 404 | Not run after the resource gate fell below 8 GB |
| Live waitlist JSONL + Mailpit | Not run; isolated temporary-file persistence and adapter error behavior passed unit tests |
| Lighthouse / capture / interaction QA | Not run after the resource gate fell below 8 GB |

Builds were admitted only after fresh resource checks passed: the final Node build started at 8.05 GB free RAM, and the successful two-phase Cloudflare build at 9.53 GB. <local-path>had approximately 120 GB free. The later check before runtime verification showed 5.27 GB free RAM. Per the owner's resource hold, runtime/browser verification is deferred; static output and unit proof are not HTTP/browser acceptance.

Lighthouse results are unknown, not passing:

| Form factor | Performance | Accessibility | Best practices | SEO |
| --- | --- | --- | --- | --- |
| Mobile, all paths | Not run | Not run | Not run | Not run |
| Desktop, all paths | Not run | Not run | Not run | Not run |

The deliberately noindex blog draft will lose SEO points when the full-path Lighthouse script runs. Do not remove its noindex merely to raise the score.

## Gzip JavaScript per page

Measured from the final Cloudflare assets plus Node-prerendered HTML. Totals include scripts, modulepreloads and their static manifest dependencies; exclude CSS/fonts and unrequested dynamic imports. Reproduce with `pnpm --filter @logbird/web exec tsx scripts/bundle-report.ts`.

| Path | KiB gzip |
| --- | ---: |
| `/` | 162.41 |
| `/product` | 162.42 |
| `/developers` | 162.42 |
| `/self-hosting` | 162.42 |
| `/cloud` | 162.42 |
| `/open-source` | 162.42 |
| `/security` | 162.42 |
| `/compare` | 162.42 |
| `/compare/retraced` | 162.42 |
| `/compare/workos-audit-logs` | 162.43 |
| `/compare/pangea` | 162.42 |
| `/compare/bemi` | 162.42 |
| `/changelog` | 162.42 |
| `/blog` | 162.42 |
| `/about` | 162.42 |
| `/contact` | 165.76 |
| `/legal/privacy` | 162.42 |
| `/legal/terms` | 162.42 |
| `/blog/draft` | 162.42 |
| `/404` | 162.13 |

## Decisions and repairs

- Use an auxiliary manifest-backed `/404` to render the root not-found component to `404.html` without masking real prerender failures.
- Prerender through Node before Cloudflare packaging. Nitro beta's initial Worker prerender attempted `npx wrangler dev` and failed with `spawn npx ENOENT` on Windows. The wrapper avoids that launcher, runs builds sequentially and rejects HTML whose asset references differ between adapters. Preview configuration pins even TanStack's build-time preview to port 4620.
- Keep shared React/router resolutions aligned in the lockfile. A rendering regression test exposed duplicate React copies; the aligned resolution passes that test while preserving the console's package version ranges.
- Native form redirects retain the requested status query and append a fragment for static, JavaScript-free CSS feedback. Static assets cannot otherwise branch on the query string.
- Preserve `.data` in the clean command. Notification failure returns 503 after retaining the local record; retries may duplicate a submission. Cloudflare remains unavailable without KV.
- Keep the OG sample at ignored `.tmp/og-home.png`. Writing the requested marketing capture path would breach the explicit app-only file boundary. No sample binary is committed inside `docs` either.

The cleanup pass reviewed the owned source/configuration and build scripts against the task contract. It removed duplicate screenshot markup and the root-route import cycle, preserved waitlist data during cleanup, corrected whitespace honeypot handling, and added static no-JS feedback. The final affected code passed package typecheck/tests, formatting/check and both build phases. Remaining gaps are the environment-blocked root gate and the resource-blocked runtime/browser checks above.

Port 4620 was confirmed free after builds. No task Node/Chrome/pnpm process remained in the worktree process inventory. No browser was opened for runtime QA; build-time previews closed when their builds finished. No explicit verification server was started.
