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
4. Create private `logbird-runtime` and `logbird-migration` Secrets from narrowly scoped
   environment files. Do not copy a developer `.env` wholesale. Both need `DATABASE_URL`,
   `BETTER_AUTH_SECRET`, `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`,
   `CLICKHOUSE_QUERY_PASSWORD` (64 lowercase hex), `REDIS_URL`; runtime also needs
   `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` when required by the provider. ConfigMap defaults
   supply the other non-secret names, including implicit SMTP TLS on port 465; verify that mode
   with the selected provider. Keep `CLICKHOUSE_QUERY_USER=logbird_query` consistent.
   Review optional overrides against [.env.example](../.env.example).
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
