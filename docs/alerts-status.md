# Alerts and status-page plan

Status: proposed thresholds and metric names, 2026-11-07. This document configures no exporter,
scrape endpoint, alert receiver or status page. Thresholds need a fictional-load baseline and
owner acceptance. Do not treat absent telemetry as zero failures or publish an uptime percentage
without a measured interval and explicit exclusions.

## Signals available now

Source inspection confirms API `/livez` checks process availability; `/readyz` checks Postgres,
ClickHouse and Redis connectivity; `/health` checks Postgres/ClickHouse. None proves SMTP,
successful ingest/readback, restricted query grants or worker consumption.
`apps/server/src/app.ts` emits `http.request` with request ID, method, path (invitation tokens redacted), status and
durationMs; `rate-limit.ts` emits `rate_limit.storage_error`. Worker startup emits `worker.ready`,
and its consumer emits `retention.completed`, `retention.failed`, `worker.error`.
`apps/worker/src/health.ts` is a separate dependency-check process, not a worker heartbeat.
The baseline has no Prometheus endpoint; the parent owns its later implementation. All
`logbird_*` names below are **proposed contracts**, not scrapeable metrics or ready alert rules.

Operate external HTTPS probes from outside the application host/failure domain. Run a small
synthetic ingest/readback against an isolated `QA Cloud canary` project with short retention and
privately stored project-specific keys; never use a customer key. Correlate by a generated ID,
not event contents. Use a separate mail sink/account for OTP receipt. Keep public probe receipts
free of keys, cookies, codes, email addresses and payloads. Log collection must strip sensitive
data and enforce access/retention; never enable sign-in-code logging for monitoring.

## Initial alert routing

Assign a primary and backup responder, escalation destination and maintenance-window owner.
P1 pages immediately and escalates after 10 minutes unacknowledged; P2 opens an operator ticket
and escalates if its stated deadline is missed. These response times are proposed targets.
Deduplicate by service/environment/alert; group dependency failures so a database outage does
not create one page per Pod. Probe absence, failed scrapes and missed heartbeats must alert.

| Condition and initial threshold | Priority | Signal / first response |
| --- | --- | --- |
| Public `/readyz` fails 3 consecutive 30-second probes, or all API replicas unready for 2 minutes | P1 | External HTTPS + Kubernetes state; check all stores and current release, fence changes |
| Synthetic event accepted but ID cannot be read within 30 seconds, 2 consecutive runs | P1 | External canary receipt; stop rollout and trace request/storage correlation; never report a successful canary on a skipped read |
| HTTP 5xx > 1% for 5 minutes with >=100 requests; low traffic uses synthetic failures | P1 | Existing structured logs initially; proposed `logbird_http_requests_total{route,method,status}`; inspect release and dependencies |
| Read/ingest p95 > 2 seconds for 10 minutes with sufficient samples | P2 | Logs initially; proposed `logbird_http_request_duration_seconds` histogram; compare baseline and query/merge pressure |
| `rate_limit.storage_error` persists for 1 minute or auth 503 increases | P1 | Log alert; Redis failure closes auth/invites but public API limits fail open; restore queue/rate-limit availability |
| 429 > 5% for 10 minutes | P2 | HTTP logs/counter; distinguish intended quotas, abuse, shared-NAT/proxy mistakes and capacity before changing limits |
| Worker heartbeat absent > 2 minutes or oldest waiting job > 10 minutes | P1 | **Missing collector**: proposed `logbird_worker_heartbeat_timestamp_seconds`, `logbird_queue_oldest_waiting_age_seconds`; verify consumer/scheduler, do not infer from dependency health |
| Any retention failure; no successful hourly sweep for > 2 hours | P2 (P1 if deletion deadline threatened) | Existing failure logs/RetentionRun rows; proposed `logbird_retention_runs_total{status}` and `logbird_retention_last_success_timestamp_seconds`; reconcile raw/derived state and retry through supported recovery |
| Data filesystem free < 25% for 15 minutes; < 15% or forecast exhaustion < 24 hours | P2 / P1 | Node/database exporter; inspect ClickHouse merges/mutations/backup staging; add reviewed capacity, never delete live event files |
| Memory pressure/OOM or repeated restarts (> 3 in 15 minutes) | P1 | Kubernetes/node state; record limits and query pressure before restarting or raising limits |
| Complete off-host recovery set age > 26 hours, any artifact missing, or restore drill overdue > 35 days | P1 for missing backup / P2 for drill | **Missing external heartbeat**: proposed `logbird_backup_last_verified_timestamp_seconds`, `logbird_restore_last_success_timestamp_seconds`; verify object/decrypt access and run the recovery procedure |
| TLS certificate expires in < 21 days / < 7 days | P2 / P1 | External certificate probe and origin cert separately; inspect issuer/renewal path |
| Two consecutive synthetic OTP failures or provider rejects/suppresses transactional mail | P1 | Mail sink/provider events; use [sender runbook](transactional-email.md), no codes in alert messages |

Metric labels must have bounded cardinality: normalized route template, method, status/class and
environment only. Never label by tenant/project/user/key/request ID, email, raw path or query.
Duration is in seconds; event logs currently use milliseconds, so conversion is required.
Backup/restore metrics belong to an external verifier so an application outage cannot manufacture
a successful heartbeat. Implement and test each collector before converting this plan to rules.
Keep raw counts and measurement windows with any dashboard/SLO report.

## Independent status page

Host a public static page at an owner-chosen `status` origin, on a separate failure domain from
Logbird's cluster, databases and authentication. It must remain readable without a Logbird login.
Choose the hosting/notification service later; no paid service or subscription is enabled here.
Components: event ingestion, event search/read, console/API, sign-in email, retention/background
processing. Keep each component's state separate; a console outage does not automatically mean
accepted events are lost. Link the independent page from the operator's incident communication.

Use investigating / identified / monitoring / resolved states and UTC timestamps. On a P1,
publish a human-reviewed initial update with observed impact, affected components and next-update
time (proposed within 15 minutes); update at least every 30 minutes during impact. State unknown
data boundaries explicitly. Probe automation may open a private incident, but must not declare
data loss or recovery without an operator's evidence. Planned maintenance has start/end, expected
write availability and rollback owner. A log or SMTP outage needs an alternate responder channel.

Resolve only after repeated external readiness and ingest/readback checks pass, workers and
retention recover, and the current image/data boundary is identified. Preserve incident timeline,
release/backup references, measured impact and follow-up actions. Publish only customer-relevant
facts; keep internal topology, keys, tenant identifiers and payloads private.

## Rehearsal required before activation

From an isolated staging environment, inject API/dependency outage, worker not polling while
dependencies remain healthy, disk-pressure signal, expired backup heartbeat, TLS expiry and
SMTP rejection. Prove the correct alert fires and reaches primary/backup responders, resolves
after recovery, respects approved maintenance and can update the independent page while Logbird
is unavailable. Store timestamps and receiver receipts. A YAML rule or dashboard screenshot is
not delivery or incident-response proof. Track missing collectors in [operations gaps](cloud-operations-gaps.md).
