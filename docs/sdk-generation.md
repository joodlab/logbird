# SDK generation spike

Measured locally on 2026-11-05. Recommend **hey-api for a future `@logbird/client` read client**,
with pinned generator dependencies and reviewed generated diffs. Keep Forge experimental.
The hand-written **`@logbird/sdk` remains the ingest SDK**, including batching, retries and backpressure.
Nothing under `experiments/` is a workspace package or imported by production code.

## Sources and exact versions

- [Forge repository](https://github.com/cloudflare/forge), Apache-2.0, cloned outside Logbird at
  `../forge`, commit `68134895e81dd3a0a005981b05a3c5e0baaff3f9`, version 0.1.0.
- [Cloudflare announcement](https://blog.cloudflare.com/forge-open-source-generation-pipeline/), published
  September 28, 2026. Its pipeline describes broader ambitions than the standalone command currently exposes.
- Forge's `packages/forge/README.md` documents the working `--target ts` interface. The top-level README
  still cautions that SDK targets are early. Source: `src/bin/forge/main.rs` and `src/link.rs:569`.
- [Hey API documentation](https://heyapi.dev/docs/openapi/typescript/get-started),
  `@hey-api/openapi-ts` **0.99.0**, registry latest stable at this run, isolated **TypeScript 6.0.3**.
- Windows Node **26.13.0**, root pnpm **10.30.3**, TypeScript **7.0.2**.
  WSL Ubuntu build: Cargo **1.99.1**, stable toolchain. Rust's repository pin is 1.99.0.
  Node 22 and a deployed edge runtime were not exercised.

## Spec export and quality

`pnpm openapi:export` calls `app.request('/openapi.json')` in-process. It never binds a port or calls
application data endpoints. It currently requires the existing `.env`, generated Prisma client and installed
dependencies because importing the app loads its environment, database and queue modules. The script closes
those clients in `finally`. It does not start backing services.

Committed outputs: `openapi/openapi.json` (34 implemented operations as of the setup endpoints) and `openapi/public.json` (3 operations:
search, detail and ingest). Objects are recursively sorted, arrays retain their semantic order, JSON is indented
with a terminal newline. Two consecutive exports were byte-identical. The exporter rejects duplicate IDs and
missing summaries, tags, security or responses.

Server changes are metadata only: shared doc helpers provide IDs, public/v1 vs console tags, session/bearer
security and the contract error envelope as the default response. IDs are fixed-summary-derived; treat those
summaries as naming inputs and preserve IDs explicitly if changing copy after publication. Management routes
previously lacked security metadata. Ingest now describes the actual contract union (batch of unknown event
values or arbitrary JSON object), not an invented stricter input. Response and validator schemas continue to
come from `packages/contracts`. Streaming export has CSV/NDJSON response media. Cookie scheme uses
`better-auth.session_token`; HTTPS deployments can use better-auth's secure cookie naming, which needs release
documentation. Health declares its JSON success shape; degraded health uses the same shape at 503.

Limitations: OpenAPI cannot capture custom Zod refinements such as allowed retention values or runtime
time-range/query-language validation. The default error schema is accurate for API error envelopes, but does
not enumerate every status. Health's 503 readiness body differs from that default error envelope. Better-auth's
wildcard routes and Scalar/self-documentation are deliberately outside the generated operation set. Routes
that are in the contracts but not implemented yet (e.g. suggest) must use `routeDoc`/`doc` from
`apps/server/src/openapi.ts` when they land, then `pnpm openapi:export` is re-run in the same PR.

## Reproduction

From the isolated Logbird worktree in PowerShell (configure the root `.env` first; never print it):

```powershell
pnpm install
pnpm db:generate
pnpm --dir experiments/hey-api install --ignore-workspace --frozen-lockfile
$env:PORT='4641'; $env:APP_URL='http://localhost:4640'
pnpm sdk:generate
node --import tsx experiments/forge/prepare.ts
```

`sdk:generate` exports both specs and generates public and full-console hey-api clients. The experiment's
separate package manifest and lock isolate its compiler API dependency; root production dependencies do not
change. `prepare.ts` adds Forge extensions only in `experiments/forge/*.input.json`. Only the generated **public**
clients are committed (they back `pnpm sdk:verify`); the full-console clients and Forge input files are
regenerable and gitignored to keep the repo small.

Forge setup and generation (PowerShell; paths here match the requested worktree):

```powershell
git clone https://github.com/cloudflare/forge ../forge
git -C ../forge checkout 68134895e81dd3a0a005981b05a3c5e0baaff3f9
wsl -d Ubuntu -- sh -lc 'cd ../forge && cargo +stable build --bin forge'
```

Then in WSL:

```sh
FORGE=../forge/target/debug/forge
cd ../logbird
"$FORGE" experiments/forge/public.input.json --target ts --out experiments/forge/public
"$FORGE" experiments/forge/console.input.json --target ts --out experiments/forge/console
"$FORGE" openapi/public.json --target cli --out /tmp/logbird-forge-cli
```

The final command deliberately demonstrates the unavailable CLI target; it exits nonzero.
The plain public spec was also tried first with `--target ts`; exit 0 produced `export interface Client {}`.
Adding `x-forge-group-name` and `x-forge-method-name` to every operation fixes this. Forge reads those names,
not standard operationId/tags, to include operations. No upstream source was patched.

Start the owned server in a separate terminal, then verify and measure:

```powershell
$env:PORT='4641'; $env:APP_URL='http://localhost:4640'
pnpm --filter @logbird/server with-env tsx src/index.ts
# In another terminal at the worktree root:
pnpm sdk:verify
pnpm exec tsc -p experiments/tsconfig.json
pnpm exec tsc -p experiments/tsconfig.forge.json
node --import tsx experiments/measure.ts
pnpm typecheck
pnpm check
pnpm test
```

The verifier reads existing Jood/JoodCMS demo data, creates one temporary read key via Prisma, keeps its secret
in memory and deletes only that exact throwaway row in `finally`. Existing keys and events remain intact.
It needs at least two `action:hotel.*` demo events in the last 89 days; it fails if that fixture is absent.
No seed/reset/backfill or retention mutation is performed. Stop the owned server when done.

## Errors and workarounds observed

1. Windows has no `cargo`. `pnpm dlx @cloudflare/forge --help` fails with registry
   `404 Not Found` / `ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST`. The documented npm distribution was
   unavailable; this does not prove native Windows code incompatibility.
2. WSL was already available. An initial `cargo --version` from the clone unexpectedly initiated the pinned
   toolchain install. A subsequent build overlapped that install, producing `could not rename 'downloaded' file`
   and `toolchain '1.99.0-x86_64-unknown-linux-gnu' is not installable`. The version command eventually recovered;
   the build succeeded with the already installed `cargo +stable build --bin forge` in 24.27 seconds.
3. Without Forge extensions the generated client is silently empty. The adaptation above is mandatory.
4. `--target cli`: `unrecognized target cli, possible values: ts, capnweb, or wasm://PATH`.
   No Logbird CLI was generated or tested; Cap'n Web is an RPC target, not a CLI replacement.
5. Hey-api loaded against root TypeScript 7 fails at `ts.SyntaxKind.AnyKeyword`:
   `TypeError: Cannot read properties of undefined (reading 'AnyKeyword')`.
   A scoped pnpm override still resolved the root peer under the hoisted linker. Isolating the generator with
   TS 6.0.3 fixes it without downgrading Logbird. An initial isolated install used host pnpm 12.6.0; pinning
   the nested packageManager to 10.30.3 and reinstalling under `CI=true` reconciled its modules layout.
6. Hey-api interprets `openapi/public.json` as registry shorthand and fails `Invalid Hey API shorthand format`.
   Use `./openapi/public.json` (as committed). Always run generation from the repository root.
7. Initial generated-client compilation with Logbird's ES2023-only libraries reports `Temporal`,
   `HeadersInit` and `BodyInit` missing. Both trees compile with `ESNext`, `DOM`, `DOM.Iterable`; Forge's
   console live request contains `since: Temporal.Instant`. Runtime Temporal support/polyfill is a separate
   concern; DOM types alone do not provide it. No generated output was hand-edited to hide failures.

## Produced API and comparison

```ts
// Forge, after adding vendor metadata
const forge = createClient({ baseUrl, token: readKey });
const page = await forge.events.publicSearchEvents({ q: 'action:hotel.*', from, to, limit: 1 });
const next = await forge.events.publicSearchEvents({ from, to, cursor: page.nextCursor! });
await forge.events.publicEventDetail({ eventId: page.data[0]!.id });

// hey-api, no vendor metadata
const client = createClient({ baseUrl, auth: readKey });
const { data } = await publicSearchEvents({ client, query: { q: 'action:hotel.*', from, to }, throwOnError: true });
```

| Concern | Forge at pinned SHA | hey-api 0.99.0 |
| --- | --- | --- |
| Public and full spec generation | Both succeed with vendor-name overlay | Both succeed directly |
| Real public read API | Search + range, distinct cursor page, detail, 401/422 pass | Same checks pass |
| Types | Preserves nullable actors, string dictionaries, query/order enums; verbose repeated inline event structures | Same faithful nullables/records/enums; unions represented as TS unions |
| Ingest union | Broad body reflects accept-anything contract; generated SDK is not batching ingest SDK | Same broad contract, no ingest guarantees |
| Runtime validation | Codec conversion, not full Zod validation; public response codec is null | Default output has types, not runtime response validation; Zod plugin not enabled |
| Authentication | Required token always sends Bearer; headers can override; cookie auth needs explicit adapter | Security-aware auth callback can select scheme; browser `credentials: 'include'`, Node Cookie header need configuration |
| Cursor paging | Manual cursor works; automatic iterators require Forge pagination metadata | Manual cursor works; no cursor iterator enabled |
| Errors | Throws ApiError with status/response/details; 401 and 422 observed | Typed error envelope and response, optional throwing; 401 and 422 observed |
| Runtime dependencies | Copied runtime, no external imports; Temporal paths require suitable runtime | Copied fetch runtime, no external runtime dependencies in chosen plugins |
| Module output | ESM with .js relative specifiers | Extensionless imports; bundler-friendly, needs ESM packaging decision |
| Node / edge | Node 26 real run; browser + Node ESM bundles; Temporal blocks an unconditional Node 22 compatibility claim | Node 26 real run; browser + Node ESM bundles; Node 22/edge execution still release gates |
| Docs | Summary JSDoc; no standalone docs artifact produced by TS target | Summary JSDoc; Scalar continues to serve canonical API docs |
| CLI | Unsupported by standalone command | Not attempted; TS SDK comparator only |
| Maintenance | Unpublished npm command, Rust/WSL build, custom extensions, early target surface | Pinned tool and separate TS compiler API; more generated runtime code, review upgrades |

`experiments/runtime-results.json` records actual local assertions; no credentials, cookies or payloads are
stored. Full-console clients were generated and compiled, but session-authenticated management, streamed
exports, ingest mutations and live polling were not exercised through them.

Bundle comparison uses esbuild 0.28.2, full public entrypoint exports, minified ESM, not a single-operation
tree-shaking benchmark. Both browser and Node builds have identical measured sizes:

| Generator | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| Forge | 4,716 | 2,165 |
| hey-api | 9,891 | 3,998 |

See `experiments/bundle-results.json` and `experiments/measure.ts`. These are local bundle measurements,
not network transfer timings or production telemetry. Forge's Apache license is retained alongside its output.

## Production path and remaining work

Adopt the deterministic spec export now. If adopting generation, create a separate `@logbird/client`
package from public.json using pinned hey-api, compiled dual ESM/CJS or an explicit ESM-only support policy,
stable exported schema names, package exports and a documented Node/edge matrix. Keep console methods private.
Split read-only output from ingest or clearly document that generated ingest is low-level only. Lock operation
IDs independently of display summaries before publishing the first version.

In this CI-less repo, maintainers run setup, `pnpm sdk:generate`, inspect the spec/client diff, typecheck,
tests and real-server smoke test locally, then commit generated output with the source contract change.
Publish `@logbird/client` only in a separately authorized release with semver/change notes and registry
credentials. Do not add PR Docker builds. Add drift detection and release automation if CI arrives later.

Estimate: 1–2 engineering days for packaging, auth examples, named response models, smoke fixtures and Node 22/
edge compatibility validation; additional scope for generated Zod validation, cookie sessions or automatic
pagination. This is a planning estimate, not measured production readiness. Revisit Forge when its distribution,
standard OpenAPI naming, general CLI target and Temporal policy are documented and stable. The smaller output
does not currently outweigh those integration costs.

Validation: workspace install, 12-package typecheck, `pnpm check`, 83 passing tests with 4 pre-existing skipped
ClickHouse tests, generated-client compile checks, repeated spec hashes and real public API reads passed.
No browser UI changed, so terminal assertions and committed JSON receipts replace screenshots/video.
Cleanup review covered only this spike's metadata, scripts and generated artifacts; shared schema conversion
removed a duplicated hand-written ingest union. No production wiring or unrelated refactor was added.
