# Compose pull policy, image naming and public API reference, 2026-11-08

Scope: #88 (the four buildable roles `migrate`, `server`, `worker`, `app` under `pull_policy: build`, with the
owner-decided names `ghcr.io/joodlab/logbird-<role>:<version>`) and #61 (`/docs` and `/openapi.json` on the public
origin of the default Compose stack and the Caddy variant). Nothing was published, no registry namespace was claimed
and no untrusted role image was pulled. Raw rows: [compose-pull-policy-2026-11-08.json](compose-pull-policy-2026-11-08.json).

Host: Windows 11, Docker Desktop engine 29.8.1 (linux/amd64). Revision 7ef2ad7 on `feat/selfhost-owner-decisions`.
Role images were built sequentially from that revision (minimum free host RAM during the builds: 9.8 GB):

| Role | Local image ID (= pushed manifest digest on this containerd-store engine) |
| --- | --- |
| migrate | `sha256:a30d3745cc70d439e78dbabaf0234803bcaea870e19ceb30ddf04e5f34e2f8ca` |
| server | `sha256:21211f0599b8d33b1953e087007dbfaf6fad5a0896d9fefc3b497c0372617635` |
| worker | `sha256:1d90451a7c33431a5bb8079b9b69bfa12670e85fb40ab39bb01ed9c9d9022f3a` |
| app | `sha256:7ef01b492490f4766cc4a780cdb0390b5ce2fcc72500fc31c1e2c0f21d664237` |

## Static configuration

| Check | Compose v5.5.1 (current) | Compose v2.24.4 (documented minimum, official binary, SHA-256 verified) |
| --- | --- | --- |
| `config --quiet` with a fictional env file | pass | pass |
| `config --images` role names | `ghcr.io/joodlab/logbird-{migrate,server,worker,app}:local` | same |
| `-f docker-compose.coolify.yml config -q` with simulated Coolify magic values | pass; same role names; `SMTP_REQUIRE_TLS` on all runtime services | not run |
| External-services override without external URLs | fails as designed (`Set external …`) | same |

## Runtime pull-policy matrix

A throwaway `registry:2.8.3` container (`sha256:a3d8aaa6…`) on `127.0.0.1:5055` held retags of the images above as
`localhost:5055/joodlab-fixture/logbird-<role>:matrix`. Two identifiers are recorded separately: the **local image
ID** (`docker image inspect --format '{{.Id}}'`) and the **registry manifest digest** (`Docker-Content-Digest` of
`HEAD /v2/joodlab-fixture/logbird-<role>/manifests/matrix` after the push). This Docker Desktop engine uses the
containerd image store (`docker info`: `driver-type io.containerd.snapshotter.v1`), where the reported image ID is the
image's manifest/index digest rather than the config hash of the classic store, so the two values were identical here
for every role (table above; recorded as `roleImages` and `registryManifestDigests` in the JSON). On a classic-store
engine they differ, and published releases must be verified by registry digest. Compose used
`LOGBIRD_IMAGE_REGISTRY=localhost:5055/joodlab-fixture`, `LOGBIRD_VERSION=matrix`, project `logbird-matrix`. "Registry
requests" counts HEAD/GET manifest requests in the registry's access log during the case. Containers were only
created (`up --no-start --no-deps`), never started.

| Case | Local image | Command | v5.5.1, all four roles | v2.24.4, all four roles |
| --- | --- | --- | --- | --- |
| A | absent | `up --no-start --no-deps --no-build <role>` | exit 1 `No such image`; 0 registry requests | exit 1 `No such image`; 0 requests |
| B | absent | `up --no-start --no-deps --no-build --pull always <role>` (release flow) | exit 0; pulled (2 requests); the pulled image's local ID equals the original local image ID (and the pushed manifest digest) | same |
| C | present | `up --no-start --no-deps --no-build <role>` | exit 0; 0 requests; no build; same ID | same |
| D | present | `up --no-start --no-deps <role>` (bare) | exit 0; **rebuilt from the checkout** (new ID); 0 requests | exit 17: build failed (see below); 0 requests; image unchanged |
| E | absent | `build <role>`, then `up --no-start --no-deps --no-build <role>` | exit 0; built, then used; 0 requests | exit 17: build failed; 0 requests |
| F | absent | `up --no-start --no-deps <role>` (bare) | exit 0; built from the checkout; 0 requests | exit 17: build failed; 0 requests |
| G | absent | migrate consumer override (`build: !reset null`, `pull_policy: never`) + `run --pull never --rm --no-deps migrate` | exit 1 `No such image`; 0 requests | exit 16: `unknown flag: --pull` |
| G2 | absent | same override, `run --rm --no-deps migrate` (no `--pull`) | not run | exit 1 `No such image`; 0 requests |

Conclusions:

- **No implicit pull of a runnable role** on either version: with a missing local image, `up --no-build` fails
  (A) and bare `up` builds (F); only the explicit release command (B) contacts the registry.
- Bare `up` rebuilds even when the image exists (D, v5.5.1), producing a new image ID. Published-image consumers
  must therefore use `up --no-build` for every later startup, as [releases](../releases.md) says.
- Compose v2.24.4's `run` has no `--pull` flag. On that version use the documented override without it (G2): the
  override's `pull_policy: never` already prevents a pull.
- On this Windows Docker Desktop host, **v2.24.4 cannot build this repository**: loading the build context fails
  with `changes out of order: "examples/hono/node_modules/hono/dist/cjs/package.json" "examples"` (and, with that
  path excluded, `"examples/hono/package.json" "examples"`), caused by the `!examples/**/package.json` negation in
  `.dockerignore`. v5.5.1 builds the same context. No pull happened in those cases. Builds with v2.24.4 on Linux
  were not tested here; on Windows use a current Compose.
- Process note: the first v5.5.1 pass ran E/F/G while a container from the previous case still referenced the image,
  so their "absent" precondition did not hold (G then ran `true` in the locally built migrate image with the
  fictional matrix env). Those rows were discarded and E/F/G re-run with a precondition guard; the table shows the
  re-run.

## Public API reference on the Compose stack and the Caddy variant (#61)

Built Compose and Caddy deployments contain no Vite dev server: the production app's Nitro handler is the only path to
the API, so the dev-only Vite fallback fixed in round 3 of PR #106 did not apply to them. The method and credential
checks below were run at 7ef2ad7; the round-3 changes to the `/docs` CSP (exact script URL and inline-script hash
instead of the jsDelivr host and `'unsafe-inline'`) were re-checked in the browser in source development.

Default stack (`docker compose --env-file <fixture> -p logbird-docsproof up -d --no-build --wait`, app on
`127.0.0.1:4790`, all services healthy), checked with `apps/app/scripts/docs-proof.mjs`:

- `GET`/`HEAD /docs` → 200 `text/html` with the `/docs` CSP; `GET`/`HEAD /openapi.json` → 200 `application/json`
  (46 operations, `servers: [{url: "http://localhost:4790"}]`); `/readyz` → 200.
- `/internal`, `/internal/metrics`, `/metrics`, `/docs/anything`, `/openapi.yaml`, `/v10/events`,
  `/server-only-probe` → the console's HTML 404, never the API's JSON 404.
- `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` on both reference paths → 405 `Allow: GET, HEAD` from the console.
- Playwright's bundled Chromium (fresh context) rendered the reference: 0 console errors/warnings or CSP
  violations; the only off-origin request was the pinned `@scalar/api-reference@1.76.0` bundle.
- Credentials: a second container from the same app image, with `LOGBIRD_SERVER_URL` pointed at a header-echo
  upstream, received fictional `Cookie` and `Authorization` headers. The upstream saw **neither** on `/docs` and
  `/openapi.json`, and **both** on `/api/…` and `/v1/…`.

Caddy variant (`--profile tls` with the documented local `tls internal` Caddyfile, `APP_URL=https://audit.logbird.test:4743`,
`TRUST_PROXY=2`), checked with `curl --resolve audit.logbird.test:4743:127.0.0.1 -k`:

- `HEAD /docs`, `/openapi.json`, `/readyz` → 200; `Strict-Transport-Security: max-age=31536000` and the `/docs` CSP present.
- The same unknown paths → console HTML 404; the same five methods on both reference paths → 405 `Allow: GET, HEAD`.
- `/openapi.json` `servers: [{url: "https://audit.logbird.test:4743"}]`.
- Chromium (host-resolver mapping, local CA ignored) rendered `/docs`: 0 problems, only the pinned bundle off-origin.

## Source development: Vite fallback removed (PR #106 round 3)

Dev stack (`turbo watch dev`, `logbird-stack` lock), probes with `curl --path-as-is`, `Sec-Fetch-Dest: image` and
fictional `Cookie`/`Authorization`. "API saw" counts the server's own `http.request` log lines during the probe.

| Config | `POST /api/../docs`, `/api/%2e%2e/openapi.json`, `/v1/../internal`, `/api/../metrics` | API saw |
| --- | --- | --- |
| Before (3618553: Vite `server.proxy` for `/api`, `/v1`) | 404 `application/json` (from the API) | `POST /docs`, `POST /openapi.json`, `POST /internal`, `POST /metrics` |
| After (no Vite proxy) | 404 `text/html` (console) | 0 requests |

After the fix, the full matrix of seven traversal paths × POST/GET × `Sec-Fetch-Dest: image`/`document` gave:
image → console 404 for all; document → `405` for POST to the reference, `200` for GET to the reference (logged by the
API as `GET /docs`/`GET /openapi.json`, forwarded without credentials by the Nitro handler), console 404 for
`/internal` and `/metrics`, and a console `307` to `/openapi.json` for the trailing-slash form. The `/docs` page also
rendered in Chromium under the tightened CSP (exact bundle URL + inline-script hash, no `'unsafe-inline'` scripts)
with 0 console errors or CSP violations.

## Cleanup

Removed by exact ID: the four role images above, every image rebuilt by the matrix, `registry:2.8.3`, the
digest-pinned `redis:7-alpine` (`sha256:c5d34a98…`) pulled by the proof stack, the registry container and its
anonymous volume, the `logbird-docsproof` and `logbird-matrix` containers, networks and volumes, the two echo
containers, and the 39 build-cache records created by these builds (removed one ID at a time; the 38 pre-existing
records were untouched). Images, containers, volumes, networks and build cache matched the pre-run baseline
afterwards.

## Not covered here

Fresh install, previous-commit upgrade and fresh-storage restore on a real Linux host and in Coolify, Compose v2.24.4
builds on Linux, GHCR ownership/visibility and published-digest verification: these follow after open-sourcing
(#88, #77).
