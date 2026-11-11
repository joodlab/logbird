# Cloud operations

This document describes operator requirements, not a production acceptance receipt.
No provisioning, deployment, failover, restore or capacity result is established by
these procedures alone.

## Hosting decision

The hosted instance is planned on Coolify behind Cloudflare at `logbird.joodlab.com` after the repository is open-sourced. Provisioning and deployment remain separate steps.

Follow the recorded [architecture decision](decisions.md) and the [Coolify deployment
guide](coolify.md) for that path. The [deployment checklist](deployment.md),
[backup and recovery procedures](backup-disaster-recovery.md) and
[operator gaps](cloud-operations-gaps.md) apply to the chosen deployment.

Qualify releases using exact source revisions, built artifacts, running identities
and isolated fictional acceptance fixtures. Measure ingest, search, retention,
backup duration and recovery before making capacity or availability claims.
A single host remains one failure domain even when it runs multiple app replicas.
Keep database listeners private, preserve existing credentials and test encrypted
transport, retention and matched recovery.

### Maintenance and recovery

The matched offline backup procedure stops API/worker writes. Measure its duration
with representative data and document the maintenance window. Test failure handling
before and after writer restart; a partial capture is not a valid recovery set.
Online Postgres PITR and incremental ClickHouse backups require a verified cross-store
boundary before they can replace that procedure. See [OPS-03](cloud-operations-gaps.md#ops-03-recovery).

Changing providers or orchestration requires restoring a complete matched recovery
set into new targets, preserving credentials, reconciling deletions and passing
acceptance before DNS cutover. The restore/repair gates tracked in
[#75](https://github.com/joodlab/logbird/issues/75) and
[#77](https://github.com/joodlab/logbird/issues/77) apply to that path.

## Kubernetes alternative

[`deploy/k3s`](../deploy/k3s) remains a documented alternative, including deployment
on Hetzner. It is not the selected hosted launch path. The Kubernetes topology,
artifact, release and static-validation sections below apply only when operators
choose that alternative. They do not provision or qualify a cluster.

Keep application roles, migration jobs and data-service responsibilities separate.
The Coolify Compose path has its own release procedure; do not use the Kubernetes
commands below for it or infer zero downtime from replica counts.

## Topology and capacity gates

A single-node k3s installation has one failure domain. Document its maintenance
and outage model before deployment. A highly available control plane uses three
control-plane nodes with fast durable disks, a private registration address and
workload placement across nodes. K3s's
[embedded-etcd HA design](https://docs.k3s.io/datastore/ha-embedded) needs at least three server
nodes and an odd quorum. It does not replicate application databases. A single-node evaluation
remains a single failure domain even with two app Pods.

Choose region, data residency and capacity using representative synthetic
benchmarks and the deployment requirements. [K3s resource profiling](https://docs.k3s.io/reference/resource-profiling) describes
control-plane overhead; it is not a Logbird sizing result. The supplied app/API/worker requests
total 1.25 CPU and 2 GiB RAM before the migration Job, rolling surge, ingress, control plane,
data services, exporters or filesystem cache. Limits and replicas are trial allocations, not
evidence for 10M events/day. Reserve room for a replacement Pod and ClickHouse merge/backup
headroom; derive disk forecasts from observed compressed growth, retention and recovery duration.

### ClickHouse background maintenance

Size ClickHouse maintenance for the measured workload and available CPU/I/O.
Development settings do not establish production capacity. For an
initial dedicated 8-vCPU/16-GiB-or-larger trial, propose `background_pool_size=8`,
`background_merges_mutations_concurrency_ratio=2`, and
`number_of_free_entries_in_pool_to_execute_mutation=2`. These are unmeasured starting
values; retain one Logbird retention consumer and serialize its project purges.
Check CPU, disk latency, free space, part growth and request tails during mixed
ingest/search/export/retention traffic before increasing maintenance concurrency.
Do not apply these values to a shared development server as part of a benchmark.

The pool controls merge/mutation threads; a larger pool consumes more CPU/I/O, and
reducing it requires restart. See [server pool settings](https://clickhouse.com/docs/reference/settings/server-settings/settings/background#background_pool_size).
The ratio allows more scheduled operations than physical threads; it is not extra
CPU capacity. Prefer starvation-free `round_robin` scheduling for a bounded purge
deadline; `shortest_task_first` can starve large tasks under sustained inserts.
See [merge/mutation scheduling](https://clickhouse.com/docs/reference/settings/server-settings/settings/background-merges).

Reserve merge capacity: the mutation free-entry threshold must not exceed
`background_pool_size * background_merges_mutations_concurrency_ratio`. Review
actual per-table overrides as well as global defaults. See the
[MergeTree mutation threshold](https://clickhouse.com/docs/reference/settings/merge-tree-settings/number-of#number_of_free_entries_in_pool_to_execute_mutation).

Before and after every measured purge/delete, capture pending `system.mutations`
counts (owned fixture versus others), age/parts remaining, pool size/tasks, and
effective server settings. Keep foreign predicates/content out of reports. Record
shared-pool contention beside duration; queued background work can delay synchronous
deletion independently of Logbird's locking. The [mutation status table](https://clickhouse.com/docs/reference/system-tables/mutations)
uses `is_done=0` for unfinished work. Repeat in an otherwise idle window for a
baseline; never kill another project's mutation, disable merges, or force `FINAL`
to manufacture a faster result. Alert on queue age and failed progress, not only count.

Keep database listeners private and allow only the application/data administration paths.
[Hetzner private Networks do not automatically encrypt traffic](https://docs.hetzner.com/networking/networks/faq/).
Use verified database TLS or a tested encrypted transport, and confirm client certificate/CA
support before accepting the hosted path. Never expose Postgres, ClickHouse, queue ports or
Kubernetes administration to the public internet. Restrict control-plane/SSH access to the
operator network. Preserve forwarded-header trust at the edge and reject plain public HTTP
or redirect it to HTTPS. Validate origin certificates independently when adding a CDN.

## Kubernetes artifact contract

[`deploy/k3s`](../deploy/k3s) contains a Kustomize baseline and an independently applied migration
Job. It installs **no database, volume, cluster, load balancer, cert-manager or monitoring stack**.
All images use a deliberately unusable `registry.invalid` reference; replace each with a real
immutable digest from a manual build of one recorded Git SHA. No published image digest is supplied here.
The server Dockerfile's `migrate` target is the migration image; API runtime images omit tooling.
Build/publish manually through the documented release process. Do not add automatic PR Docker builds
or CI workflows. No build, push or deployment is performed by Kustomize.

**Artifact qualification is a release and recovery prerequisite.** The chosen source
must contain [PR #51](https://github.com/joodlab/logbird/pull/51)'s retention-SQL
embedding fix, now merged on master at `6be8ba0`, or an equivalent verified change.
Confirm the selected revision contains the generated embedding; source merge does
not qualify built artifacts. Record the fix commit,
all four built digests and actual running image IDs. Exercise real expired-row
retention and failed-run repair through those exact built API/worker digests, then
compare survivor IDs and logical values in all three aggregate tables. Migration
success or SQL present in the migration image does not qualify runtime packaging.
The separate native-restore mutation-version defect [#75](https://github.com/joodlab/logbird/issues/75)
also blocks production recovery until its accepted fix link/revision and the
[restore/repair/repeated-repair checkpoints](backup-disaster-recovery.md#logical-aggregate-checkpoints-a-b-c)
pass with the exact images. [#77](https://github.com/joodlab/logbird/issues/77) tracks
the remaining packaged guard/normalization and retry gates; record their accepted
revisions and receipts before clearing recovery. Keep packaging and restore gates separate.

Before applying, make a private release copy preserving `deploy/k3s` and
`scripts/wait-k8s-job.sh` at their repo-relative paths. Run the following from
that copy's `deploy/k3s` directory:

1. Use Kustomize image digests and record source SHA, architecture, build commands,
   running imageIDs and rollback digests. From the private `deploy/k3s` copy:

   ```sh
   : "${SERVER_DIGEST:?}" "${APP_DIGEST:?}" "${WORKER_DIGEST:?}"
   kustomize edit set image "registry.invalid/logbird/server=registry.example.test/logbird/server@$SERVER_DIGEST"
   kustomize edit set image "registry.invalid/logbird/app=registry.example.test/logbird/app@$APP_DIGEST"
   kustomize edit set image "registry.invalid/logbird/worker=registry.example.test/logbird/worker@$WORKER_DIGEST"
   # Each digest must be sha256:<64 hex>; use the approved real registry hostname.
   # Edit migration/job.yaml separately to its qualified migrate@sha256:... image.
   ```

   For a private registry, create `logbird-registry` from a protected existing
   Docker config and patch the dedicated namespace's default ServiceAccount:

   ```sh
   kubectl -n logbird create secret generic logbird-registry \
     --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson=/secure/registry-config.json
   kubectl -n logbird patch serviceaccount default --type=merge \
     -p '{"imagePullSecrets":[{"name":"logbird-registry"}]}'
   ```

   This is a first-install hook; preserve existing credentials/entries on upgrades.
   Record the inherited imagePullSecrets on new runtime and migration Pods. No token
   mount is needed for pulling images.
2. Complete [cluster bootstrap, DNS, Local ingress and cert-manager issuance](cloud-ingress.md).
   Base Kustomize excludes public `edge/`; apply it only for the operator window.
3. Create the external databases and verify readiness using a separate authorized infrastructure
   procedure. Match versions in [self-hosting](self-hosting.md): Postgres 17, ClickHouse 26.9,
   Redis 7, or tested Dragonfly with `--cluster_mode=emulated --lock_on_hashtags=true` and
   `noeviction` behavior. Keep `{logbird}` identical on every producer/worker. Never reset a
   shared service to prepare this deployment.
4. Prepare three narrowly scoped private Secret files using the existing credential
   values; this separation does not authorize credential rotation or new database users.
   Do not copy a developer `.env` wholesale. Required keys are:

   | Secret | Keys / purpose |
   | --- | --- |
   | `logbird-runtime` | API: `DATABASE_URL`, `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `REDIS_URL`, `BETTER_AUTH_SECRET`, `CLICKHOUSE_QUERY_PASSWORD` (64 lowercase hex); `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` as required by the selected provider |
   | `logbird-worker` | Retention/health/queue only: `DATABASE_URL`, `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `REDIS_URL`. The manifest names these five `secretKeyRef` entries explicitly; no API auth secret, restricted-query password or SMTP credentials are mounted |
   | `logbird-migration` | One-shot schema/access tooling: `DATABASE_URL`, `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, preserved `CLICKHOUSE_QUERY_PASSWORD`; no auth or mail credentials |

   Back up the three object names, key inventories and encrypted recovery references
   with the matched set. Restore/recreate each scoped Secret with its preserved credentials;
   changed restore endpoints follow the [ordered cutover](backup-disaster-recovery.md#cut-over-to-restored-targets).
   Do not replace the worker Secret with the API file. ConfigMap defaults supply the
   non-secret settings. Verify outbound SMTP connectivity from the deployment host.
   Configure the provider's supported port and TLS mode, require fail-closed STARTTLS
   on port 587, and test downgrade rejection and real OTP delivery before launch.
   Do not change the baseline's 465/TLS settings without validating the new transport. See [mail prerequisites](transactional-email.md#hetzner-launch-prerequisite).
   Keep `CLICKHOUSE_QUERY_USER=logbird_query`
   consistent for API/migration. Review overrides against [.env.example](../.env.example).
5. Give the migration identity Postgres DDL and the ClickHouse schema/access-management grants
   listed in self-hosting. Give runtime only its required data rights. Current retention and
   management paths mutate data; a read-only runtime identity is insufficient. Preserve existing
   keys and passwords. Secret separation alone does not prove the final privilege set works.
   Restrict Secret RBAC, enable datastore encryption, and protect off-host secret recovery.
6. Verify Traefik namespace/Pod labels against `network-policies.yaml`. It allows Traefik to app
   port 4600 and app to API port 4601; no public API Service or worker listener exists. Kubelet
   probe traffic follows the CNI's node rules. Host-network ingress, controller label differences
   and node-sourced traffic require a real isolation test. Egress is intentionally unrestricted
   until external data, DNS and SMTP destinations are known; enforce reviewed egress rules
   before production. Confirm NetworkPolicy enforcement is enabled in the cluster.

Only app/API Pods run two replicas; the worker uses `Recreate` and one replica to avoid casually
increasing retention concurrency. Pod distribution, disruption budgets and node-loss capacity
are an explicit pre-launch topology task. These manifests alone make no HA claim.

## Manual release sequence

Kubernetes alternative only: use the [Coolify guide](coolify.md) for the selected
hosted path. The common acceptance and recovery requirements still apply.

### Runtime write boundaries and migration exception

App, API and worker containers have `readOnlyRootFilesystem: true`, with their only
writable mount at `/tmp`: a disk-backed `emptyDir` limited to 64 MiB. `TMPDIR` points
there; group 1000 owns volume access. Per-container ephemeral-storage requests/limits
are 64/128 MiB, covering scratch and logs. This configuration is statically checked,
not proof that each real image works. Qualify the exact digests under these mounts:
boot/probes, OTP, ingest/read/export, expired-row retention/repair and shutdown must
pass; writes to application code must fail. Add any required extra writable path
only as an audited bounded mount, without disabling runtime root protection.

**Narrow migration-only exception:** the one-shot Job explicitly retains a writable
root while Prisma/pnpm and the selected migration image's complete write set remain
unverified. It has no listener, one non-root container, no automatic retry, a
20-minute deadline, migration-only credentials and no service-account token. Its
`/tmp` volume is limited to 256 MiB, with `TMPDIR` and `XDG_CACHE_HOME` directed there;
ephemeral-storage request/limit is 256/512 MiB. This exception does not extend to any
Deployment. Current query-user tooling receives the preserved password from env and
does not need to append an env file in that mode. Audit remaining cache/tool writes
before accepting the exception.

Before production, audit the full migration command against the exact #51-or-equivalent
image in isolated targets, recording paths, ownership, peak scratch/layer usage and
failure/permission behavior without secret values. Bake tooling into the artifact;
do not install it at migration time. If all writes fit audited scratch/cache mounts,
enable read-only root for the Job too. Otherwise the release receipt must bound and
justify this exact image's one-shot exception and cleanup; do not silently widen it.

### Execute the qualified release

Serialize releases using the operator's release lock and record its owner. Review
every migration for compatibility. Fence/drain below, then capture a matched
[recovery set](backup-disaster-recovery.md#capture-procedure) before migrations.
Until a rolling transition is rehearsed, schedule maintenance, block public writes, drain
in-flight ingestion/exports and stop old workers and API processes before migrations. The query
user provisioning step checks unchanged main-user counts; concurrent ingestion can invalidate it.
Freeze all other clients as well as these Deployments. Preserve the old images and configuration.

#### Fence and drain

Run from the private `deploy/k3s` release copy after confirming the kubeconfig/context,
external data identities and rollback receipt. Use `set -eu` in each shell. First
apply only namespace/network policy; on upgrades preserve existing Secrets:

```sh
set -eu
kubectl config current-context
kubectl apply -f namespace.yaml
kubectl -n logbird apply -f network-policies.yaml
# Fence: base apply -k deliberately excludes edge/ and cannot recreate this Ingress.
kubectl -n logbird delete ingress logbird --ignore-not-found --wait=true
```

From an external non-allowlisted source verify the app/auth/ingest routes are rejected,
including any alternate hostname/Ingress. Wait for existing requests/exports and
acknowledged inserts to drain; then stop API and worker writers. First install skips
the scale step because no old Deployments exist:

```sh
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' "https://$PUBLIC_HOST/readyz"
# Non-allowlisted source: 404 while fenced, 403 in the operator window; never 200.
```

```sh
# Upgrade only, after the external fence and drain have been observed:
kubectl -n logbird scale deployment/logbird-server deployment/logbird-worker --replicas=0
kubectl -n logbird wait --for=delete pod -l app.kubernetes.io/name=logbird-server --timeout=300s
kubectl -n logbird wait --for=delete pod -l app.kubernetes.io/name=logbird-worker --timeout=330s
```

Fence all direct/administrative writers too, take the matched recovery set, and
record the stopped-Pod inventory. A drain timeout keeps the release stopped;
never force-kill a purge to meet a maintenance estimate.

**First install only:** create the three scoped Secrets, then the registry hook
above if needed. Never print files or use a wholesale developer `.env`.

```sh
set -eu
kubectl -n logbird create secret generic logbird-runtime --from-env-file=/secure/logbird-runtime.env
kubectl -n logbird create secret generic logbird-worker --from-env-file=/secure/logbird-worker.env
kubectl -n logbird create secret generic logbird-migration --from-env-file=/secure/logbird-migration.env
```

**Upgrade only:** verify names and key inventories privately; preserve existing
Secret values, auth keys and registry entries. Add a missing scoped worker Secret
from the existing authorized values once; do not recreate all Secrets or rotate them.

```sh
set -eu
kubectl -n logbird get secret logbird-runtime logbird-worker logbird-migration -o name
```

**Both paths:** apply configuration only after the old writers are stopped. Use a
unique Job name and exact migration digest in `migration/job.yaml`:

```sh
set -eu
: "${MIGRATION_JOB:?Set logbird-migrate-<unique-release-id>, matching job.yaml}"
kubectl -n logbird apply -f config.yaml
kubectl -n logbird apply -f migration/job.yaml
sh ../../scripts/wait-k8s-job.sh "$MIGRATION_JOB"
```

If the Job fails or times out, stop: preserve its status/logs, investigate applied migrations and
use the recovery decision below. Do not automatically rerun, delete evidence or unblock traffic.
The Job has no automatic retries and a 20-minute deadline. It uses the image CMD to deploy
Postgres migrations, ClickHouse migrations and query-user grants in that order.
The immutable-id upgrade (ClickHouse 006–009) is the exception to that deadline on
large histories. Each copy statement has its own 600-second server budget
(`CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS`, which may be set in the migration
Secret). Its final coverage pass grows roughly with the square of retained events:
measured at about 62 seconds for 10M and extrapolated to about 80 minutes at
100M. See the [upgrade copy limits](self-hosting.md#upgrade-copy-limits). Time a
restored production copy first, and when the estimate exceeds the Job's 20-minute
`activeDeadlineSeconds`, raise it for that one release's Job. A deadline kill
mid-copy is safe to rerun, but it repeats a pre-swap copy from the start.
If nothing starts within about one minute, inspect
`kubectl -n logbird get pods -l job-name="$MIGRATION_JOB"` for ImagePullBackOff or
unschedulable Pods rather than waiting silently for the deadline.

After the helper reports Complete, apply only the base and wait for all three rollouts:

```sh
kubectl -n logbird apply -k .
kubectl -n logbird rollout status deployment/logbird-server --timeout=300s
kubectl -n logbird rollout status deployment/logbird-app --timeout=300s
kubectl -n logbird rollout status deployment/logbird-worker --timeout=300s
kubectl -n logbird get ingress logbird --ignore-not-found
# Required: no application Ingress. edge/ has not been applied.
```

Applying the base is a manual gate on the Job. Readiness does not
certify the schema migration inventory. Preserve the failed Job until its incident evidence is
archived; prune only release-owned completed Jobs under a separate retention policy.

The API uses `/livez` for startup/liveness and `/readyz` for routing. App readiness proxies
`/readyz`; TCP liveness avoids restarting it just because storage is unavailable. The worker's
`node dist/health.mjs` checks dependency connectivity in a separate process; it does **not**
prove that the existing consumer is polling. It has no dependency-triggered liveness restart.
The extra Node readiness process shares the worker's 1 GiB memory limit: measure
combined peak RSS/cgroup usage with concurrent retention and a probe, and leave
headroom or change the probe design before qualifying that image (OPS-02).
Verify `worker.ready`, its scheduler and a real completed retention job. The 300-second worker
grace period needs long-running retention/drain evidence before relying on it.

The hourly worker compacts a bloated receipt primary key after recovery and project
retention. `REINDEX INDEX CONCURRENTLY` requires table ownership, or the table's
`MAINTAIN` privilege on PostgreSQL 17+ (see [REINDEX](https://www.postgresql.org/docs/17/sql-reindex.html)). A non-owner worker without that grant logs
`ingest.receipt_index_compaction_failed` with code `42501`; recovery and retention
continue. Dropping invalid `_ccnew`/`_ccold` reindex copies additionally requires
ownership of the table/index (see [DROP INDEX](https://www.postgresql.org/docs/17/sql-dropindex.html)), so a maintenance-only role needs owner-assisted
cleanup when a cancelled rebuild leaves a copy.
The hourly job drops any invalid `IngestReceipt_pkey_ccnew*`/`_ccold*` copy matching
the reindex naming pattern, including an operator's in-progress manual REINDEX
CONCURRENTLY. Pause the worker for a manual rebuild and resume it afterwards.

## Acceptance and rollback

Use the [local port-forward, then operator-IP-only HTTPS window](cloud-ingress.md#fence-and-operator-acceptance-window)
for the [smoke procedure](deployment.md#acceptance) against isolated fictional fixtures.
Capture OTP delivery, login, tenant isolation, ingest 202
and readback of the same ID, Query/SQL denial, retention completion and HTTPS/header/client-IP
checks. Record skipped smoke inputs as gaps. Inspect each Pod's `imageID` alongside the registry
digest, migration inventory and source SHA. A third source must remain denied during
the edge window; prove the two-source rate-limit separation and spoofing check.
Only then use the explicit [unfence command](cloud-ingress.md#unfence-and-refence).

Require the artifact qualification above before selecting release or rollback images.
Record retention/failed-repair evidence for the exact API/worker digests, plus #75/#77's
restore/repair/repeated-repair checkpoints before recovery. Keep production recovery
fenced when either prerequisite or any logical comparison is missing or mismatched.

Test node/process restarts, a failed migration, dependency outages, recovery and a rejected
unhealthy rollout before launch. Measure any request interruption continuously; RollingUpdate
settings do not establish zero downtime. Proposed telemetry is in [alerts and status](alerts-status.md).
Assign operators for signup, quotas and workspace lifecycle. Launch only after
the linked acceptance gates have passing evidence for the serving revision.

If no incompatible migration ran, restore the previous image digests and configuration under
the release lock, then repeat acceptance before reopening traffic. For an incompatible schema
or partial cross-store migration, keep writes frozen and restore the **whole matched recovery
set into new isolated targets** before switching. Do not run old code blindly against new state,
undo migrations by deleting history, or overwrite the only surviving production data.

## Static validation

From the repository root, render without a cluster connection and validate the standard resources:

```sh
kubectl kustomize deploy/k3s > /tmp/logbird-k3s.yaml
kubectl kustomize deploy/k3s/edge > /tmp/logbird-edge.yaml
kubeconform -strict -summary -kubernetes-version 1.35.0 /tmp/logbird-k3s.yaml deploy/k3s/migration/job.yaml deploy/k3s/platform/acme-network-policy.yaml
# Validate edge/platform CRDs against the pinned Traefik/cert-manager/K3s schemas,
# not by silently skipping unknown resource kinds.
git diff --check
```

Run local static tests with
`node --test scripts/k3s-manifests.test.mjs scripts/wait-k8s-job.test.mjs`.
They check the **raw objects and raw apply commands**, independently of Kustomize's
namespace transformer. Every application object must explicitly target `logbird`;
the Traefik platform object is explicitly in `kube-system`. No real kubectl is run
by these tests. Any separate render must use an empty kubeconfig and credential-free
environment, never the operator's host/cloud context.

The opt-in local receipt test is
`LOGBIRD_CLOUD_RECEIPT_TEST=1 node --env-file=.env --test scripts/cloud-dr-receipts.integration.test.mjs`.
It requires localhost and the existing `logbird` database, creates only UUID-owned
QA tables plus session-private Memory expectations, validates native 006/007 engines
and checked-in SQL with QA object names substituted, then verifies cleanup. It
creates no database/user/settings
and changes no application table. Check available memory and isolate concurrent test runs before execution.
Validate both native engine variants, raw namespace assertions and cleanup.

The baseline retains v1.34 restricted Pod Security rules and is schema-checked
against Kubernetes 1.35 for the proposed pinned K3s release. Repeat against the
actual chosen controller/chart/engine versions before installation.
Schema checks cannot verify image availability, Secret values, CNI behavior, SMTP, migration
privileges, probes against running images, backups or real traffic. Operators must complete the
[issue-ready launch gates](cloud-operations-gaps.md) under an authorized test environment.

## Launch checklist

- [ ] Document the chosen platform, region, data residency, data-service model and
  maintenance/outage behavior; representative load and sizing evidence exists.
- [ ] #51 embedding is present in the accepted SHA; exact image retention/repair passes.
- [ ] #75/#77 packaged restore/guard/normalization/retry and conditional event_ids checks pass.
- [ ] Bootstrap, DNS, renewed production TLS, CNI/data isolation and both-IP buckets pass.
- [ ] Outbound SMTP connectivity, the configured TLS mode, downgrade rejection
  and real OTP delivery pass from the deployment host.
- [ ] Scoped Secrets, readonly runtimes, migration exception audit, image pull and
  failed-Job handling pass against qualified images.
- [ ] Matched off-host recovery, deletion reconciliation, measured outage/RPO/RTO,
  automated nightly fence/capture/verify/reopen, alert delivery/runbooks and
  independent status access pass.
- [ ] Functional tunnel and operator-only edge acceptance pass; record the
  acceptance evidence before unfencing. Remaining gates are listed in [operations gaps](cloud-operations-gaps.md).
