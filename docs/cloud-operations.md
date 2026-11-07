# Cloud operations preparation

Status: proposed operating design, reviewed against source and primary documentation on
2026-11-07. No infrastructure, DNS, certificates, mail account or monitoring service is provisioned
by these files. No production, failover, restore or capacity acceptance is claimed.

## Hosting decision

Recommend **k3s on Hetzner for the hosted cloud**, with Postgres, ClickHouse and Redis/Dragonfly
operated independently of the stateless release. This is an engineering recommendation based
on the existing Kubernetes operating model and Logbird's durable-event contract, not a measured
cost or availability comparison. Keep [Coolify](coolify.md) for a bounded private evaluation
whose maintenance interruptions are acceptable. Both require the same data recovery gates.

| Consideration | k3s on Hetzner | Coolify |
| --- | --- | --- |
| Existing fit | JoodCMS has Kubernetes workloads, separate migration Jobs and infrastructure state procedures | Logbird already has a Git-build Compose definition; Nibleaf documents its operational limits |
| Releases | Separate Job completion gate; independent app/API/worker replacement | Compose reconciles services and has an interruption window; eligible Docker Image apps can overlap containers |
| State | External data services need their own storage, backup and failover design | Platform backups and application database backups have different scopes; queue persistence needs separate coverage |
| Operator burden | Cluster, ingress, certificates, upgrades and data operations | Platform/host upgrades, data operations and application compatibility |
| Availability | Multiple stateless Pods are only one part of availability | Health checks alone do not establish continuous availability |

[Coolify's rolling-update documentation](https://coolify.io/docs/applications/deployments/rolling-updates)
excludes Docker Compose applications and describes the health, shutdown and compatibility
requirements for eligible applications. Moving to separate image applications would be a
separate release design; do not describe the existing Compose path as zero downtime.

Read-only source comparisons used here: JoodCMS `k8s/README.md`,
`k8s/templates/api/{deployment,migration-job}.yaml` and `infra/terraform/README.md` separate
workloads, migrations and state ownership; Nibleaf `operations/deployment-reliability.md` and
`docs/self-hosting/backups-upgrades.mdx` require exact artifacts and isolated restore evidence.
Those sources describe practices; their current deployed behavior was not inspected. No
credentials, addresses, state, chart values or deployment scripts were copied from either project.

## Topology and capacity gates

For an availability target, plan three control-plane nodes with fast durable disks and a private
registration address, plus capacity for stateless workloads on distinct failure domains. K3s's
[embedded-etcd HA design](https://docs.k3s.io/datastore/ha-embedded) needs at least three server
nodes and an odd quorum. It does not replicate application databases. A single-node evaluation
remains a single failure domain even with two app Pods.

Choose the region, data residency, budget and capacity only after fictional representative
benchmarks. [K3s resource profiling](https://docs.k3s.io/reference/resource-profiling) describes
control-plane overhead; it is not a Logbird sizing result. The supplied app/API/worker requests
total 1.25 CPU and 2 GiB RAM before the migration Job, rolling surge, ingress, control plane,
data services, exporters or filesystem cache. Limits and replicas are trial allocations, not
evidence for 10M events/day. Reserve room for a replacement Pod and ClickHouse merge/backup
headroom; derive disk forecasts from observed compressed growth, retention and recovery duration.

### ClickHouse background maintenance

Use a dedicated cloud ClickHouse maintenance budget. The shared development server's
two-thread pool is a constrained test environment, not a cloud sizing result. For an
initial dedicated 8-vCPU/16-GiB-or-larger trial, propose `background_pool_size=8`,
`background_merges_mutations_concurrency_ratio=2`, and
`number_of_free_entries_in_pool_to_execute_mutation=2`. These are unmeasured starting
values; retain one Logbird retention consumer and serialize its project purges.
Check CPU, disk latency, free space, part growth and request tails during mixed
ingest/search/export/retention traffic before increasing maintenance concurrency.
Do not apply these values to the owner's shared server as part of a benchmark.

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
Build/publish manually through the owner's release process. Do not add automatic PR Docker builds
or CI workflows. No build, push or deployment is performed by Kustomize.

**Artifact qualification is a release and recovery prerequisite.** The chosen source
must contain [PR #51](https://github.com/joodlab/logbird/pull/51)'s retention-SQL
embedding fix, or an equivalent verified change. Record the accepted fix commit,
all four built digests and actual running image IDs. Exercise real expired-row
retention and failed-run repair through those exact built API/worker digests, then
compare survivor IDs and logical values in all three aggregate tables. Migration
success or SQL present in the migration image does not qualify runtime packaging.
The separate native-restore mutation-version defect [#75](https://github.com/joodlab/logbird/issues/75)
also blocks production recovery until its accepted fix link/revision and the
[restore/repair/repeated-repair checkpoints](backup-disaster-recovery.md#logical-aggregate-checkpoints-a-b-c)
pass with the exact images. No accepted #75 fix revision is identified in this
baseline; record it before clearing that gate. Keep these two prerequisites separate.

Before applying, make a private release copy of this directory outside Git and:

1. Replace all four image references with verified `repository@sha256:...` values. Record image
   digests, source SHA, architecture, build commands and rollback digests in the release receipt.
   Configure an image-pull Secret on each Pod if the registry is private.
2. Replace both `audit.example.test` occurrences and `MAIL_FROM`; supply a valid
   `logbird-origin-tls` Secret in namespace `logbird` through the cluster's certificate lifecycle.
   The Ingress assumes the `traefik` class. It does not install HTTPS redirection or renew a cert.
   Configure HTTPS redirection at the controller and test renewal/expiry alarms separately.
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
   with the matched set. Restore/recreate each scoped Secret with its preserved values;
   do not replace the worker Secret with the API file. ConfigMap defaults supply the
   non-secret settings, including implicit SMTP TLS on port 465 for the API; verify
   that mode with the selected provider. Keep `CLICKHOUSE_QUERY_USER=logbird_query`
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
does not need to append an env file in that mode. Cache/tool writes elsewhere have
not been measured, and are not claimed necessary.

Before production, audit the full migration command against the exact #51-or-equivalent
image in isolated targets, recording paths, ownership, peak scratch/layer usage and
failure/permission behavior without secret values. Bake tooling into the artifact;
do not install it at migration time. If all writes fit audited scratch/cache mounts,
enable read-only root for the Job too. Otherwise the release receipt must bound and
justify this exact image's one-shot exception and cleanup; do not silently widen it.

### Execute the qualified release

Serialize releases using the operator's release lock and record its owner. First take and verify
a matched [recovery set](backup-disaster-recovery.md). Review every migration for compatibility.
Until a rolling transition is rehearsed, schedule maintenance, block public writes, drain
in-flight ingestion/exports and stop old workers and API processes before migrations. The query
user provisioning step checks unchanged main-user counts; concurrent ingestion can invalidate it.
Freeze all other clients as well as these Deployments. Preserve the old images and configuration.

The following is an operator procedure for the prepared private release directory, **not a command
to run against an arbitrary current context**. Confirm the cluster/context and external database
identities privately first. On upgrades, scale old `logbird-server` and `logbird-worker` to zero
only after ingress is fenced and requests/jobs have drained; verify termination before proceeding.
On first install no old writers exist. Do not apply `workloads.yaml` before the Job succeeds.

```sh
kubectl apply -f namespace.yaml -f config.yaml
kubectl -n logbird create secret generic logbird-runtime --from-env-file=/secure/logbird-runtime.env
kubectl -n logbird create secret generic logbird-worker --from-env-file=/secure/logbird-worker.env
kubectl -n logbird create secret generic logbird-migration --from-env-file=/secure/logbird-migration.env
# On an existing install preserve these Secrets; do not recreate or rotate them.
kubectl apply -f network-policies.yaml -n logbird
# Edit job.yaml: unique name logbird-migrate-<release-id> and exact migration digest.
kubectl apply -f migration/job.yaml
kubectl -n logbird wait --for=condition=complete job/logbird-migrate-<release-id> --timeout=1250s
```

If the Job fails or times out, stop: preserve its status/logs, investigate applied migrations and
use the recovery decision below. Do not automatically rerun, delete evidence or unblock traffic.
The Job has no automatic retries and a 20-minute deadline. It uses the image CMD to deploy
Postgres migrations, ClickHouse migrations and query-user grants in that order.

After a successful Job, apply `kubectl apply -k .`, then wait for each Deployment rollout
(`kubectl -n logbird rollout status deployment/logbird-server --timeout=300s`, and likewise
`logbird-app`, `logbird-worker`). Applying the baseline is a manual step, not an enforced
dependency on the Job; a single `apply -k` is not a safe release procedure. Readiness does not
certify the schema migration inventory. Preserve the failed Job until its incident evidence is
archived; prune only release-owned completed Jobs under a separate retention policy.

The API uses `/livez` for startup/liveness and `/readyz` for routing. App readiness proxies
`/readyz`; TCP liveness avoids restarting it just because storage is unavailable. The worker's
`node dist/health.mjs` checks dependency connectivity in a separate process; it does **not**
prove that the existing consumer is polling. It has no dependency-triggered liveness restart.
Verify `worker.ready`, its scheduler and a real completed retention job. The 300-second worker
grace period needs long-running retention/drain evidence before relying on it.

## Acceptance and rollback

Keep traffic fenced while running the [production smoke procedure](deployment.md#acceptance)
against isolated fictional fixtures. Capture OTP delivery, login, tenant isolation, ingest 202
and readback of the same ID, Query/SQL denial, retention completion and HTTPS/header/client-IP
checks. Record skipped smoke inputs as gaps. Inspect each Pod's `imageID` alongside the registry
digest, migration inventory and source SHA; a registry tag or healthy Pod is not revision proof.

Require the artifact qualification above before selecting release or rollback images.
Record retention/failed-repair evidence for the exact API/worker digests, plus #75's
restore/repair/repeated-repair checkpoints before recovery. Keep production recovery
fenced when either prerequisite or any logical comparison is missing or mismatched.

Test node/process restarts, a failed migration, dependency outages, recovery and a rejected
unhealthy rollout before launch. Measure any request interruption continuously; RollingUpdate
settings do not establish zero downtime. Proposed telemetry is in [alerts and status](alerts-status.md).
Parent-owned cloud readiness/account design governs product signup, quotas, workspace lifecycle
and launch approval; this operating baseline does not supersede those gates.

If no incompatible migration ran, restore the previous image digests and configuration under
the release lock, then repeat acceptance before reopening traffic. For an incompatible schema
or partial cross-store migration, keep writes frozen and restore the **whole matched recovery
set into new isolated targets** before switching. Do not run old code blindly against new state,
undo migrations by deleting history, or overwrite the only surviving production data.

## Static validation

From the repository root, render without a cluster connection and validate the standard resources:

```sh
kubectl kustomize deploy/k3s > /tmp/logbird-k3s.yaml
kubeconform -strict -summary -kubernetes-version 1.34.0 /tmp/logbird-k3s.yaml deploy/k3s/migration/job.yaml
git diff --check
```

The baseline uses Kubernetes 1.34 schemas and a v1.34 restricted Pod Security policy; these are
validation targets, not a claim that this is the newest Kubernetes release. Choose a supported,
pinned k3s release and repeat validation against its Kubernetes version before installation.
Schema checks cannot verify image availability, Secret values, CNI behavior, SMTP, migration
privileges, probes against running images, backups or real traffic. The parent must complete the
[issue-ready launch gates](cloud-operations-gaps.md) under an authorized test environment.
