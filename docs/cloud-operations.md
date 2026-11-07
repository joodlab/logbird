# Cloud operations preparation

Status: proposed operating design, reviewed against source and primary documentation on
2026-11-07. No infrastructure, DNS, certificates, mail account or monitoring service is provisioned
by these files. No production, failover, restore or capacity acceptance is claimed.

## Decision summary

- **Recommend k3s on Hetzner:** reuse the team's JoodCMS Kubernetes practice, keep
  migrations separate from running apps, and replace each role independently.
  Coolify is simpler to set up, but its Compose deployment path has an interruption
  window and does not remove the database/recovery work.
- **Budget:** roughly **EUR 230–300/month for phase 1**, excluding VAT, labor,
  transactional mail, domain, private registry, transfer overage and independent
  monitoring; see the dated bill below.
- **Effort estimate:** 3–5 engineer-days for platform setup and rehearsals, plus
  4–8 hours/month for patching, restore drills and alert checks **only after OPS-03's
  nightly fence/capture/verify/reopen automation is implemented and rehearsed**.
  That automation is launch-blocking; its implementation is additional, **unestimated**
  setup work outside the 3–5 engineer-days. A named primary/backup night on-call
  or paging rota is required **even with automation**; it removes routine attended
  hours, not incident response. Default policy (owner may explicitly override):
  dump/encrypt/upload/readback failure before writer restart reopens traffic with
  the previous good backup still current and a P1 **nightly backup missing** alert;
  readiness/canary failure after restart stays fenced and pages the rota. That
  latter failure remains an ingest outage until recovery. Record the decision in
  [OPS-03](cloud-operations-gaps.md#ops-03-recovery).
  Without automation, an illustrative 0.5–0.75 attended hours/night × 30 adds **15–22.5 hours
  of night work/month**, or 19–30.5 hours including routine work, plus an explicit
  primary/backup night rota. Measure the actual run duration; these are estimates,
  not measured staffing costs. Do not approve the smaller effort figure for manual nights.
- **Data ownership is an open owner decision:** this budget assumes self-run
  Postgres, ClickHouse and Redis/Dragonfly on three separate data VMs. Approve that
  operational responsibility or obtain managed-service quotes before provisioning.
- **Stages:** phase 1 is one k3s server plus the data VMs; two app replicas on that
  server do not survive its loss. Phase 2 adds two k3s servers for a three-member
  HA control plane and tests node placement/capacity; data HA is a separate decision.
- **Top three risks:** unproven restored-data recovery (#75/#77); single-node/data-VM
  outages and nightly backup downtime; login failure from SMTP blocks or collapsed
  client-IP limits. Each is a launch gate below, not an accepted customer risk.
- **Reconsider** if nobody can own data/on-call, the owner rejects maintenance
  outages, managed-service quotes are cheaper than staff time, CX capacity is
  unavailable, or the measured workload/SLO requires dedicated compute or data HA.
- **Nightly ingest outage:** the current matched backup stops API/worker writes.
  Its duration is unmeasured. Time dumps, queue capture and readiness at representative
  size, then extrapolate by bytes/throughput and add drain/verification time before
  offering a maintenance window. OPS-03's longer-term **online backups (Postgres
  PITR + ClickHouse incremental, no nightly fence)** require a verified cross-store
  boundary; that is the alternative that removes the nightly outage.

### Dated cost worksheet

Planning date **2026-11-07**, Nuremberg/Helsinki, EUR excluding VAT. VM figures use
Hetzner's [public website price data](https://www.hetzner.com/_resources/app/data/bench/cloud_data.json),
fetched on that date; the [small source-hashed receipt](verification/cloud-prices-2026-11-07.json)
records each SKU/region. Confirm the Console quote and capacity before approval.
The website currently flags cost-optimized capacity as unavailable, so this worksheet
uses regular-performance CPX plans rather than assuming the cheaper CX tier is orderable.

| Phase-1 item | Monthly basis | EUR/month |
| --- | --- | --- |
| k3s server, CPX32 | 1 × 35.49 | 35.49 |
| Postgres VM, CPX32 | 1 × 35.49 | 35.49 |
| ClickHouse VM, CPX42 | 1 × 69.49 | 69.49 |
| Queue VM, CPX22 | 1 × 19.49 | 19.49 |
| Public IPv4 for four VMs (data ports firewalled) | 4 × 0.50 | 2.00 |
| Optional server backups on all four VMs | 20% × 159.96 | 31.99 |
| Extra volumes + encrypted off-host object storage | Planning allowance; quote the required GB, retention and transfer separately | 30–50 |
| Hetzner LB / extra k3s workers | None in phase 1's direct-node path | 0 |
| **Subtotal / contingency budget** | **224–244 before contingency** | **230–300** |

[IPv4 pricing](https://docs.hetzner.com/cloud/servers/primary-ips/overview/#pricing)
and [server backup billing](https://docs.hetzner.com/cloud/billing/faq/) support those
add-ons. The storage row is an explicit estimate, not an asserted list price: quote
[Volumes](https://www.hetzner.com/cloud/block-storage/) and
[Object Storage](https://www.hetzner.com/storage/object-storage/) after measuring
compressed growth and backup size. Server snapshots exclude attached Volumes and
never replace matched application backups. Reserve staging space and deletion-protected
off-host copies. Included local disks are not evidence that the data fits.

Phase 2's two additional CPX32 servers, IPv4 and optional backups add about EUR 86;
budget roughly EUR 320–420 total with contingency, **before data replicas**. Any
extra workload nodes add their quoted VM/storage costs. An optional later Hetzner
LB needs a fresh quote and the client-IP design in [ingress](cloud-ingress.md);
it is not included or required by the direct-node plan. Dedicated CPU, managed
databases, extra transfer and separate-provider recovery copies can change this bill
substantially. Obtain those quotes if the load test or recovery objectives require them.

### Switching later

The OCI images and Kubernetes resources can move, but data cannot move merely by
redeploying them. Change providers or orchestration only by restoring a complete
matched recovery set into new targets, preserving credentials and reconciling
deletions, then passing acceptance before DNS cutover. **That migration path remains
fenced by [#75](https://github.com/joodlab/logbird/issues/75) and live tracker
[#77](https://github.com/joodlab/logbird/issues/77)**, including packaged restored-part
guards, normalized retry and conditional event-ID receipt checks. There is no
accepted switching guarantee until those gates and a timed restore drill pass.

## Hosting decision

Keep [Coolify](coolify.md) for a bounded private evaluation whose maintenance
interruptions are acceptable. Data operations and recovery gates apply to both choices.

| Consideration | k3s on Hetzner | Coolify |
| --- | --- | --- |
| Existing fit | Reuses JoodCMS Kubernetes and migration-Job operating practice | Uses the supplied Compose path, adding a separate control panel to operate |
| Releases | Gate one migration Job, then replace app/API/worker independently | Compose replacement has an interruption window; separate Docker Image apps would be another design |
| State | Separate data VMs or approved managed stores; matched backups and restore ownership stay with the team | Same data responsibility; the panel's own backup/encryption key is additional state |
| Operator burden | Team owns K3s/CNI/ingress/cert-manager upgrades plus the data services | Team owns host/panel upgrades plus the same data services |
| Growth path | One server first; three-member control plane/placement when justified | Keep one-host Compose evaluation until a separately qualified deployment model is selected |

[Coolify's rolling-update documentation](https://coolify.io/docs/applications/deployments/rolling-updates)
excludes Docker Compose applications and describes the health, shutdown and compatibility
requirements for eligible applications. Moving to separate image applications would be a
separate release design; do not describe the existing Compose path as zero downtime.

Read-only source comparisons used here: JoodCMS `k8s/README.md`,
`k8s/templates/api/{deployment,migration-job}.yaml` and `infra/terraform/README.md` separate
workloads, migrations and state ownership; Nibleaf `operations/deployment-reliability.md` and
`docs/self-hosting/backups-upgrades.mdx` require exact artifacts and isolated restore evidence.
No credentials, addresses, state or deployment scripts were copied from either project.

## Topology and capacity gates

Phase 1 intentionally accepts one k3s failure domain while launch gates are proved;
owner approval of that maintenance/outage model is required. Phase 2 uses three
control-plane nodes with fast durable disks, a private registration address and
workload placement across nodes. K3s's
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
   non-secret settings. **Hetzner blocks outbound 25/465 by default**; request
   unblocking after account eligibility (one month and first invoice paid), and retain
   approval plus actual connection/OTP proof. Port 587 is reachable, but requires
   OPS-06's fail-closed `requireTLS` implementation and downgrade test before launch.
   Do not simply flip the baseline's 465/TLS settings. See [mail prerequisites](transactional-email.md#hetzner-launch-prerequisite).
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
The cloud/backend owner owns signup, quotas and workspace lifecycle; the release
owner approves launch after the linked issues have executed acceptance evidence.

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
and changes no application table. Follow current RAM/lock rules before execution.
The dated [Round 5 receipt](verification/cloud-operations-round5-2026-11-07.md)
records both native engine variants, raw namespace assertions and cleanup.

The baseline retains v1.34 restricted Pod Security rules and is schema-checked
against Kubernetes 1.35 for the proposed pinned K3s release. Repeat against the
actual chosen controller/chart/engine versions before installation.
Schema checks cannot verify image availability, Secret values, CNI behavior, SMTP, migration
privileges, probes against running images, backups or real traffic. The release owner must complete the
[issue-ready launch gates](cloud-operations-gaps.md) under an authorized test environment.

## Launch checklist

- [ ] Owner approves region, spend, self-run versus managed data services, on-call and
  phase-1 single-node/nightly-outage model; representative load/sizing receipt exists.
- [ ] #51 embedding is present in the accepted SHA; exact image retention/repair passes.
- [ ] #75/#77 packaged restore/guard/normalization/retry and conditional event_ids checks pass.
- [ ] Bootstrap, DNS, renewed production TLS, CNI/data isolation and both-IP buckets pass.
- [ ] Hetzner 25/465 unblock request is approved **and tested**, or port 587 has
  shipped fail-closed `requireTLS` with downgrade rejection and real OTP proof.
- [ ] Scoped Secrets, readonly runtimes, migration exception audit, image pull and
  failed-Job handling pass against qualified images.
- [ ] Matched off-host recovery, deletion reconciliation, measured outage/RPO/RTO,
  automated nightly fence/capture/verify/reopen, alert delivery/runbooks and
  independent status access pass.
- [ ] Functional tunnel and operator-only edge acceptance pass; release owner signs
  the receipt before unfencing. Remaining gates are listed in [operations gaps](cloud-operations-gaps.md).
