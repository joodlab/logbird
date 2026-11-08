# Cloud operations launch gaps

Status: launch checklist, 2026-11-07. Checkboxes require dated source/image and
executed evidence; a written procedure or closed PR alone does not close a gate.
Operators record responsibilities and evidence for the chosen deployment.
Coolify is the [selected hosted path](decisions.md); Kubernetes-specific checks
apply only to the documented alternative in [cloud operations](cloud-operations.md).

| ID / tracker | Responsible role | Priority | Blocks launch? | Depends on |
| --- | --- | --- | --- | --- |
| [OPS-01 telemetry / #54](https://github.com/joodlab/logbird/issues/54) | Backend maintainer + SRE | P1 | Yes | Collection access policy and alert receiver |
| [OPS-02 worker progress / #55](https://github.com/joodlab/logbird/issues/55) | Worker maintainer + SRE | P1 | Yes | OPS-01, qualified worker image |
| [OPS-03 recovery / #56](https://github.com/joodlab/logbird/issues/56) | Data operator + release engineer | P0 | Yes, including provider switching | #75/#77, OPS-08, deletion inventory |
| [OPS-04 artifacts / #57](https://github.com/joodlab/logbird/issues/57) | Release engineer | P0 | Yes | #51 embedding, registry, OPS-03 |
| [OPS-05 platform / #58](https://github.com/joodlab/logbird/issues/58) | Platform operator | P0 | Yes | OPS-08, region/DNS configuration |
| [OPS-06 email / #59](https://github.com/joodlab/logbird/issues/59) | Email/backend maintainer | P0 | Yes | SMTP unblock or shipped mandatory TLS on 587 |
| [OPS-07 deletion / #60](https://github.com/joodlab/logbird/issues/60) | Cloud/backend maintainer | P0 | Yes | Queued workspace purge, OPS-03 |
| [OPS-08 data hosting / #87](https://github.com/joodlab/logbird/issues/87) | Platform + data operator | P0 | Yes | Data residency, operating model, measured sizing |
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

- [ ] Automate and rehearse the offline backup sequence: fence, drain, matched
  three-store capture, encryption/upload/readback verification, writer restart,
  readiness/canary and unfence. Persist phase transitions and test interruption
  before and after writer restart; never publish a partial set or retry blindly.
- [ ] Document the recovery failure policy. Before writer restart, a failed capture
  may reopen unchanged live stores only after reduced readiness/canary checks,
  retaining the previous good backup and raising a missing-backup alert. A failed
  readiness/canary check after restart stays fenced and raises an incident alert.
  Test alert delivery and withhold the backup-success heartbeat on either failure.
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
- [ ] Measure offline-backup ingest downtime at representative size and document
  the maintenance window. Online Postgres PITR and incremental ClickHouse backups
  require a verified cross-store boundary before replacing the offline procedure.
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

- [ ] Configure the selected Coolify/Cloudflare deployment and data services from
  OPS-08. For the Kubernetes alternative, configure the pinned K3s/OS/private network.
  Record topology, firewall paths, DNS A/AAAA and supported version inventory.
- [ ] For Kubernetes, execute the [ingress/DNS/cert-manager procedure](cloud-ingress.md);
  for Coolify, use its domain and proxy configuration. Prove real
  certificate issuance/renewal, SNI/chain, HTTP rejection and expiry alert delivery.
- [ ] Two source IPs must produce two auth buckets; reject forged forwarding headers.
- [ ] Prove ingress isolation (including CNI rules when using Kubernetes), reviewed
  DNS/data/SMTP egress, verified encrypted
  database transport and no public database/API/dashboard bypass route.
- [ ] Prove fence, tunnel, operator-only window, unfence/refence and failed-release behavior.
- [ ] Test host/node outage and document the observed impact. Any HA/node-loss
  claim needs measured proof, placement and disruption policy.
- [ ] Write/rehearse **disk-pressure and OOM runbooks (TBD)** before those alerts activate.

## OPS-06 email

- [ ] Verify outbound SMTP connectivity from the chosen host and require the
  configured TLS mode. Test fail-closed STARTTLS on port 587; a reachable port or
  opportunistic TLS alone does not establish secure delivery.
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

- [ ] Document self-run or managed data services, region, residency, access and
  backup requirements, and the selected deployment's failure domains.
- [ ] Configure each store privately with version-pinned persistence, encrypted
  transport and tested grants. Keep development data and services isolated.
- [ ] Use measured ingest/storage/search/purge results to establish disk, memory,
  maintenance and backup headroom. Validate replication or HA against the SLO
  before claiming availability or recovery guarantees.

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
