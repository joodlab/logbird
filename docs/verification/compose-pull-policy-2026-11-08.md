# Compose pull policy and image naming (#88), 2026-11-08

Scope: the four buildable roles (`migrate`, `server`, `worker`, `app`) under `pull_policy: build`, with the
owner-decided image names `ghcr.io/joodlab/logbird-<role>:<version>` ([decisions](../decisions.md)). Nothing was
published, no registry namespace was claimed and no untrusted role image was pulled. The live fresh install,
upgrade and restore on the real host follow after open-sourcing.

## Static configuration (done)

Fictional env files under the ignored `.tmp/`, no containers started.

| Check | Compose v5.5.1 (current) | Compose v2.24.4 (documented minimum, official release binary, SHA-256 verified) |
| --- | --- | --- |
| `docker compose --env-file <fixture> -f docker-compose.yml config --quiet` | pass | pass |
| `config --images` role names | `ghcr.io/joodlab/logbird-{migrate,server,worker,app}:local` | same |
| `-f docker-compose.coolify.yml config -q` with simulated Coolify magic values | pass, same role names, `SMTP_REQUIRE_TLS` on all three runtime services | not run |
| External-services override without external URLs | fails as designed (`Set external REDIS_URL` / `DATABASE_URL`) | same |

## Runtime matrix (pending: host RAM)

Planned and scripted locally; **not yet executed**. The first sequential role build was aborted by the RAM guard
(free host RAM fell from 8.9 GB to 5.7 GB from other workloads; the build was stopped, nothing was left running,
and its partial build-cache records are recorded for exact-ID removal). The results will be added to this file.

Design, per role and per Compose version (v5.5.1 and v2.24.4):

- A throwaway `registry:2` container on `127.0.0.1:5055` holds retags of the role images built from this checkout,
  as `localhost:5055/joodlab-fixture/logbird-<role>:matrix`. Its access log shows whether Compose requested a
  manifest. The registry container and fixture tags are removed by exact ID afterwards.
- Containers are only created (`up --no-start --no-deps`), never started, so no role process receives the fixture
  environment.

| Case | Local image | Command | Expected |
| --- | --- | --- | --- |
| A | absent | `up --no-start --no-deps --no-build <role>` | fails; no registry request |
| B | absent | `up --no-start --no-deps --no-build --pull always <role>` (release flow) | pulls the fixture explicitly |
| C | present | `up --no-start --no-deps --no-build <role>` | uses the local image; no pull, no build |
| D | present | `up --no-start --no-deps <role>` (bare) | builds from the checkout; no pull |
| E | absent | `build <role>`, then `up --no-start --no-deps --no-build <role>` | builds, then uses it; no pull |
| F | absent | `up --no-start --no-deps <role>` (bare) | builds from the checkout; no pull |
| G | absent | migrate consumer override (`build: !reset null`, `pull_policy: never`) with `run --pull never` | fails; no registry request |
