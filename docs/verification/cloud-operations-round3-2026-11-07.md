# Cloud operations Round 3 verification

Date: 2026-11-07. PR #53, branch `docs/cloud-operations-readiness`; merged master
`cc68aad3aeaa92192d1a4aefd5010e3783f570a4` via `8948518`. Final commit is recorded
in the PR's Round 3 comment. This receipt covers source, schemas and local reference
queries, not a deployed cloud or completed restore.

| Check | Executed result |
| --- | --- |
| Pinned pnpm 10.30.3 frozen install | Pass; 0 downloaded/added |
| `pnpm exec turbo run typecheck --concurrency=1` | 17/17 tasks pass |
| `pnpm check` | 406 files; 0 errors, 76 existing warnings |
| Serial package tests | 419 passed, 134 opt-in/service cases skipped across 45 passed files and 4 skipped files; see invocation note below |
| `pnpm exec turbo run build --concurrency=1` | 11/11 tasks pass, zero cache hits |
| Kustomize + strict kubeconform, Kubernetes 1.35 | 17 resources valid, 0 invalid/errors/skipped, including CRDs |
| Manifest invariants | Base has no public route; edge defaults to two-source allowlist/websecure; Local ingress, untrusted forwarding, readonly runtime roots and five-key worker Secret pass |
| Local documentation links/anchors | 56 pass, including this receipt |
| Shell wait helper | `sh -n` pass; isolated command stubs for Complete / Failed / API error return 0 / 1 / 7 |
| ClickHouse reference SQL | Real shared local engine 26.9.19.9; private temporary Memory tables only; four correct independently known maps produce empty differences and all four injected duplicate/doubling corruptions are detected |
| Conditional event-ID SQL | Two positive and two negative receipt-map/physical-duplicate assertions pass on temporary Memory tables; FINAL removed for that test, so no ReplacingMergeTree/restore acceptance is claimed |
| Postgres inventory SQL | All five statements plan against the local `logbird` schema inside a read-only transaction; no user data printed |
| Diff/cleanup review | `git diff --check` passes; task-owned docs/manifests/SQL/helper reviewed; no actionable slop remaining |

Test invocation: `pnpm exec turbo run test --concurrency=1 -- --maxWorkers=1
--no-file-parallelism` passed the other test packages but supplied a duplicate
`--maxWorkers` to the server's existing script. Corrected server command
`pnpm --filter @logbird/server test --no-file-parallelism` passed 20 files/62 tests,
with 1 file/48 opt-in HTTP cases skipped, in 565.30 seconds. Combined totals above
use that corrected run. This duration is not a throughput benchmark; the shared
ClickHouse sample showed 2 pending mutations and a two-thread maintenance pool.

CRD schema inputs (public upstream, downloaded only to private temporary validation
storage; no cluster installation):

- [HelmChartConfig schema](https://github.com/k3s-io/helm-controller/blob/71be4991f2652515a2bb7f7464399f6733297964/pkg/crds/yaml/generated/helm.cattle.io_helmchartconfigs.yaml), SHA256 `492cbaebc4b3b9db5226c8784db82f442991b2ff399ed65f4f83c0f50160071d`.
- [Traefik v40 Middleware schema](https://github.com/traefik/traefik-helm-chart/blob/v40.0.0/traefik/crds/traefik.io_middlewares.yaml), SHA256 `0ff75808cf3a872c064599960e65fe5ed0bffee8361e45d29d98a76dfcd8220b`.
- [cert-manager v1.21.3 CRDs](https://github.com/cert-manager/cert-manager/releases/download/v1.21.3/cert-manager.crds.yaml), SHA256 `29810b2a84c8ee0731a79679ee1dfd7e93cd750eb0244542eec47fa8700f2749`.

HelmChartConfig's values string also passed explicit Local/DaemonSet/forwarding-trust
assertions. Actual chosen K3s/controller/chart versions still require qualification.
Standard schemas and CRD schemas were checked without skipping unknown kinds.

The first shell-helper stub test used the wrong Windows PATH form and attempted a
read with the host kubeconfig; expired authentication prevented cluster access.
The corrected test uses an empty isolated kubeconfig and a verified stub path.
No cluster resource was read successfully or changed; no credentials were refreshed.

Follow-up: the committed [wait-helper harness](../../scripts/wait-k8s-job.test.mjs)
replaces the ad-hoc check. Before every subprocess it supplies an empty temporary
kubeconfig, isolated HOME/config directories, an allowlisted environment (no cloud
credentials or startup hooks), and a PATH containing only its stub directory. A
deliberately missing stub must exit 127; no real kubectl fallback is possible.
`node --test scripts/wait-k8s-job.test.mjs`: **5/5 pass**, including child-side
environment assertions and the missing-stub case. Master `2a9d378` is merged in
`ff9f18c`; the original source/build counts above remain the dated Round 3 baseline.

Round 4 follow-up checks: current frozen install, typecheck **17/17**, source build
**11/11** (9 cache hits), app tests **171/171**, hermetic harness **5/5**, and lint
**420 files / 0 errors / 76 existing warnings** pass after that merge. Real ClickHouse checks pass for
non-empty fixtures, expected/actual raw and receipt manifest counts, and wrong
project/count rejection; the previous comparison/corruption checks still pass.
The UTC-typed export parameter reports UTC. The new Postgres cutoff assertion
passes two boundary cases and rejects six missing/wrong/out-of-gap cases using
synthetic CTEs in read-only transactions. All seven temporary ClickHouse tables
were dropped. All **29 shell blocks** parse in a credential-free environment with
an empty kubeconfig; none of those commands executed. **58 links/anchors** pass.
Nightly automation, actual reopen and live release/IP/restore proof remain open
OPS-03/#77 launch gates; these checks do not certify the proposed procedures.

Cleanup/resources: all seven SQL-test temporary tables dropped; no persisted SQL
fixtures or schema changes from those checks. All own test/build processes ended;
`build-a` released. No stack, browser, Docker image or infrastructure was started.
Temporary rendered YAML, schemas, logs and the local SQL check harness remain outside
Git. Sampled free RAM reached **20.64 GiB**, free <local-path>**109.06 GiB**; continuous or
per-process peaks were not measured. Disk changes include other threads' activity.

Unfulfilled acceptance: actual K3s bootstrap, certificates/renewal, network isolation,
two external-IP buckets, SMTP unblock/mandatory TLS and real inbox receipt, exact-image
permission probes, matched archive fetch/restore and #75/#77 packaged recovery. No
application or API contract changed. UI screenshots are not applicable; equivalent
configuration/query evidence is above. See [launch gates](../cloud-operations-gaps.md).
