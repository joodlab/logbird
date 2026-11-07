# Cloud operations launch gaps

Status: launch checklist, 2026-11-07. Checkboxes require dated source/image and
executed evidence; a written procedure or closed PR alone does not close a gate.
The release owner assigns a person to each named role before provisioning.

| ID / tracker | Owner role | Priority | Blocks launch? | Depends on |
| --- | --- | --- | --- | --- |
| [OPS-01 telemetry / #54](https://github.com/joodlab/logbird/issues/54) | Backend maintainer + SRE | P1 | Yes | Collection access policy and alert receiver |
| [OPS-02 worker progress / #55](https://github.com/joodlab/logbird/issues/55) | Worker maintainer + SRE | P1 | Yes | OPS-01, qualified worker image |
| [OPS-03 recovery / #56](https://github.com/joodlab/logbird/issues/56) | Data operator + release owner | P0 | Yes, including provider switching | #75/#77, OPS-08, deletion inventory |
| [OPS-04 artifacts / #57](https://github.com/joodlab/logbird/issues/57) | Release engineer | P0 | Yes | #51 embedding, registry, OPS-03 |
| [OPS-05 platform / #58](https://github.com/joodlab/logbird/issues/58) | Platform operator | P0 | Yes | OPS-08, region/DNS approval |
| [OPS-06 email / #59](https://github.com/joodlab/logbird/issues/59) | Email/backend maintainer | P0 | Yes | SMTP unblock or shipped mandatory TLS on 587 |
| [OPS-07 deletion / #60](https://github.com/joodlab/logbird/issues/60) | Cloud/backend maintainer | P0 | Yes | Queued workspace purge, OPS-03 |
| [OPS-08 data hosting / #87](https://github.com/joodlab/logbird/issues/87) | Product owner + data operator | P0 | Yes; owner decision open | Budget, residency, on-call, measured sizing |
| [OPS-09 client-IP guard / #86](https://github.com/joodlab/logbird/issues/86) | Backend/security maintainer | P1 | Two-IP proof blocks launch; warning is follow-up defense | OPS-05, bounded sampling design |

## OPS-01 telemetry

- [ ] Define actual metrics/log names, units, bounded route labels and access policy;
  proposed names in [alerts](alerts-status.md) are not implemented collectors.
- [ ] Test secret exclusion, normalized route labels and milliseconds-to-seconds conversion.
- [ ] Prove external collection, absent-scrape/outage alerts and primary/backup delivery.
- [ ] Commission the independent status page and test access during a cluster/mail outage.

## OPS-02 worker progress

- [ ] Heartbeat must reflect the active consumer; collect oldest job age and sweep freshness.
- [ ] Stopping consumption with healthy stores must fire the canary and alert.
- [ ] Prove lease recovery and drain within the 300-second Pod grace, or change the contract.
- [ ] Measure combined worker + exec-readiness Node process memory during retention;
  qualify headroom below the 1 GiB cgroup limit or redesign the probe.
- [ ] Write and rehearse the **worker-stuck runbook (TBD)** before activating that alert.

## OPS-03 recovery

- [ ] **Launch-blocking nightly automation:** implement/rehearse fence, drain,
  three-store capture, encryption/upload/readback verification, writer restart,
  one-host operator-window readiness/canary and unfence. On failure leave traffic
  fenced, page the night rota and withhold success heartbeat; test each interrupted phase.
  The 4–8-hour monthly routine estimate assumes this exists, not manual night work.
- [ ] #75 is the restore-specific mutation-version defect; [#77](https://github.com/joodlab/logbird/issues/77)
  is the live acceptance tracker. Record accepted guard/procedure revisions and exact image IDs.
- [ ] Prove logical raw/minute/entity/attribute values after restore, failed-run repair and
  repeated repair, with parts/mutations, original archives and no-restore control preserved.
- [ ] If 006/007 exists, select receipt checks from inventory AND actual engine; prove
  the 006 logical FINAL map or 007 distinct sets/oldest lookup, MV destination and
  no unexplained physical growth from B to C.
- [ ] Execute the committed dry-run/normalization procedure only under #77's accepted
  offline prerequisites; no automatic data repair or speculative workaround.
- [ ] Capture a matched encrypted three-store/config set, fetch it from off-host and
  verify checksums/decryption; prove deletion reconciliation and measured RPO/RTO.
- [ ] Measure nightly ingest downtime at representative size and get owner acceptance.
  Longer-term alternative: **online backups (Postgres PITR + ClickHouse incremental,
  no nightly fence)** with a proved cross-store boundary. This removes the nightly
  outage; scheduling the fenced procedure merely removes attended work.
- [ ] Prove missing-artifact/decrypt/overdue alerts and independent recovery credentials.

## OPS-04 artifacts

- [ ] Master `6be8ba0` includes #51's SQL embedding. Inspect the selected release
  revision for that embedding or an equivalent verified implementation. Record source SHA, architecture and all four immutable digests.
- [ ] Provide reviewed manual image build/registry/publish and release-receipt tooling;
  no automatic PR Docker builds. Preserve rollback digests and private pull credentials.
- [ ] Run real expired retention and failed-run repair through those API/worker digests,
  comparing survivor IDs and logical aggregate values; migration success is insufficient.
- [ ] Validate read-only runtime roots/bounded scratch and the exact migration image's
  writable-root exception audit. Verify worker's five-key Secret allowlist.
- [ ] Prove failed/cancelled migration handling, running imageIDs and compatible rollback.
- [ ] Measure traffic during replacement before claiming zero downtime; OPS-03/#77
  remains an independent recovery gate.

## OPS-05 platform

- [ ] Provision the approved pinned K3s/OS/private network and data services from OPS-08;
  record topology, firewall paths, DNS A/AAAA and supported version inventory.
- [ ] Execute [Local ingress/DNS/cert-manager procedure](cloud-ingress.md), prove real
  certificate issuance/renewal, SNI/chain, HTTP rejection and expiry alert delivery.
- [ ] Two source IPs must produce two auth buckets; reject forged forwarding headers.
- [ ] Prove CNI ingress isolation, reviewed DNS/data/SMTP egress, verified encrypted
  database transport and no public database/API/dashboard bypass route.
- [ ] Prove fence, tunnel, operator-only window, unfence/refence and failed-release behavior.
- [ ] Test phase-1 node outage and document accepted impact; phase-2 HA/node-loss capacity
  needs separate measured proof, placement and disruption policy.
- [ ] Write/rehearse **disk-pressure and OOM runbooks (TBD)** before those alerts activate.

## OPS-06 email

- [ ] Hetzner blocks outbound 25/465 by default. Retain unblock request/approval and
  actual 465 connectivity proof, or ship/test fail-closed `requireTLS` for 587.
  A reachable port or optional STARTTLS does not meet the gate.
- [ ] Verify SPF/DKIM/DMARC alignment and real OTP/invitation/notification receipt.
- [ ] Keep code logging off; exercise TLS/downgrade, timeout, provider quota, bounce
  and suppression failures without leaking codes or addresses.
- [ ] Prove SMTP-connect-timeout alerting and independent incident access; follow the
  [sender runbook](transactional-email.md#delivery-acceptance-and-failure-handling).

## OPS-07 deletion

- [ ] Implement durable scoped queued workspace purge/retry state and deny access immediately.
- [ ] Prove deleted workspace raw/derived rows reach zero while another QA tenant is unchanged.
- [ ] Exercise interruption/retry and restored-deletion reconciliation before launch.

## OPS-08 data hosting decision

- [ ] Owner chooses **self-run data VMs or managed services**, region, residency and
  provider/access/backup contracts. [Cost worksheet](cloud-operations.md#dated-cost-worksheet)
  currently assumes one VM per Postgres/ClickHouse/queue, without data HA.
- [ ] Obtain current quotes for selected SKUs, GB, transfer, backups, registry, mail
  and monitoring; approve budget plus setup/on-call responsibility by name.
- [ ] Provision/configure each store privately with version-pinned persistence,
  encrypted transport, tested grants and no shared/local development substitutions.
- [ ] Use measured ingest/storage/search/purge data to approve disk/memory/headroom,
  maintenance capacity and backup outage; choose data replication/HA if the SLO needs it.

## OPS-09 client-IP guard

- [ ] Implement the bounded startup/observed-traffic warning from [#86](https://github.com/joodlab/logbird/issues/86).
  Startup cannot infer collapse without samples; one user/NAT alone is not a fault.
- [ ] Prove no raw IP/identity secrets, unbounded maps or per-address metric labels;
  document any operator-readiness contract/access change.
- [ ] Retain the real two-source and forwarding-spoof acceptance receipt from OPS-05.

Close gates with the applicable commit/image IDs, commands, output, UTC date and
cleanup receipt. Static schema validation, a backup exit code and HTTP 200 prove
only their named scope. Procedures: [cloud](cloud-operations.md),
[ingress](cloud-ingress.md), [recovery](backup-disaster-recovery.md),
[alerts/status](alerts-status.md), [email](transactional-email.md).
