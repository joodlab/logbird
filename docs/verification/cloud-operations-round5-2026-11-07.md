# Cloud operations Round 5 verification

Date: 2026-11-07. PR #53; master `6be8ba00fdfeef54f24ea24cd434a8120c4310fe`
(#51) merged via `8932b39`. The Round 5 PR comment records the final head.
Earlier [Round 3/4 evidence](cloud-operations-round3-2026-11-07.md) remains historical.

## Namespace correctness

- All **14 application resources** explicitly declare `metadata.namespace: logbird`,
  including every NetworkPolicy, Deployment, Service, Ingress and Middleware.
- The one repo-owned platform exception is the named Traefik HelmChartConfig in
  `kube-system`; Namespace and ClusterIssuer are cluster-scoped. The upstream
  cert-manager installer owns its platform namespaces.
- Namespace creation is a separate command; application raw applies use
  `kubectl -n logbird apply -f ...`. Traefik's raw apply selects `kube-system`.
- `node --test scripts/k3s-manifests.test.mjs scripts/wait-k8s-job.test.mjs`:
  **8/8 pass**, including missing raw namespace rejection and hermetic missing-stub
  exit 127. Static namespace assertions inspect raw source, not transformed output.
- Strict Kubernetes 1.35 plus pinned upstream CRD schema validation: **17/17 valid,
  zero invalid/errors/skipped**. Raw documents were concatenated in scratch storage.
  No kubectl, cluster connection or independent Kustomize render was executed.

## Engine-specific receipt verification

`LOGBIRD_CLOUD_RECEIPT_TEST=1 node --env-file=.env --test scripts/cloud-dr-receipts.integration.test.mjs`:
**8/8 pass** on local ClickHouse **26.9.19.9**. Expected maps/multiplicity/migration
inventory used session-private Memory tables; actual QA tables used native
ReplacingMergeTree and plain MergeTree. Only UUID-owned test objects were changed.

| Case | Observed result |
| --- | --- |
| 006 A | Native FINAL map selects the expected two logical IDs despite legacy versions; observed physical count 2 after replacing compaction |
| 006 B/C | Expected survivor FINAL map and physical ceiling pass on native ReplacingMergeTree |
| 007 A | Five physical rows, four distinct full tuples, two IDs; overlapping backfill accepted and oldest received-at lookup exact |
| 007 B/C | Four physical rows, three distinct tuples, two IDs; received-at ties resolve by timestamp |
| Extra repeated-repair copy | Physical count grows from four to five while distinct sets/canonical lookup stay unchanged; growth check rejects it |
| Altered oldest tuple / unexpected full tuple | Both canonical and complete-tuple EXCEPT checks detect differences |
| Inventory/engine/fixture mismatch | Wrong inventory, wrong engine, empty project and wrong manifest count fail closed |
| Interrupted 007 | UUID-owned v2 staging object causes an engine/state guard failure |

Cleanup verified all **five owned QA tables and three temporary Memory tables**
were removed. No database, user or server setting was created; no application table,
shared migration inventory, real project or queue was changed. No retention mutation
was queued: fresh QA tables model B/C. This validates the checked-in reference SQL with QA object names substituted,
not a packaged application restore, migration, retention or repair run.

## Source checks and limits

Frozen install passes; typecheck **17/17**, source build **12/12** (11 cache hits),
ClickHouse package tests **162 passed / 86 gated skips**. Lint passes **434 files,
0 errors / 76 existing warnings**; **63** current runbook/receipt links and anchors
pass, and **29** shell blocks parse without execution in a credential-free sandbox.
The task-owned cleanup review found
no actionable slop remaining. No application/API contract changed.

The merged master includes #51's source SQL embedding and backup configuration;
runtime guard/normalization/retry acceptance remains in **#77**. Reference links now
use the merged files; the conditional 006/007 behavior is pinned to #62 at `97b03c2`.
Actual K3s/TLS/IP/SMTP/nightly automation and exact-image recovery gates stay open.
No stack, browser, Docker image, cloud account or real cluster was started/touched.
Build-a was released; own processes ended. Temporary validation logs/schemas remain
outside Git. Sampled free RAM **22.75 GiB**, free C: **109.85 GiB**; continuous and
per-process peaks were not measured, and shared machine activity affects disk totals.
