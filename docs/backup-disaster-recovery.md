# Backup and disaster recovery

Status: operator runbook and launch gate, 2026-11-07. No backup schedule, off-host copy,
restoration or RPO/RTO has been measured by this change. Commands require a separately authorized,
identified environment; a drill always uses new isolated targets and fictional acceptance fixtures.

## Objectives and ownership

Assign a primary operator and a backup operator, incident contact, approved storage region,
encrypted off-host destination and retention policy before launch. Proposed initial planning
targets are **RPO <= 24 hours**, **RTO <= 4 hours**, with a nightly matched recovery set and a
fresh set before every schema release. These are targets requiring owner acceptance and timed
rehearsal, not customer promises. If nightly fencing is unacceptable, design and rehearse an
online cross-store recovery boundary before accepting production traffic. Independent Postgres
PITR and ClickHouse backups are not automatically transactionally aligned. The current
nightly fence creates an ingest outage; measure drain + dump + off-host verification
+ readiness at representative size and publish the approved maintenance window.
An online boundary/WAL-PITR plus ClickHouse incremental design is tracked in OPS-03.

Use a separate recovery credential/account and tested emergency access. Encrypt backup artifacts,
restrict decrypt/restore access, and keep an independently protected copy whose deletion is not
available to the normal application identity. Select retention to satisfy the actual deletion
and legal policy; suggested 7 daily/4 weekly copies require approval. Never expire the last known
restore-tested set automatically. Audit retention changes and periodically verify object existence,
readability and key access from a recovery host.

## Contents of one recovery set

| Artifact | Required contents and verification |
| --- | --- |
| Postgres | Database custom dump, needed roles/grants, schema migration inventory; verify archive listing and isolated restore |
| ClickHouse | `logbird` database including raw events, rollups and materialized-view definitions; access users/profiles/row policies or a tested reprovisioning recipe with preserved credentials |
| Queue | Consistent Redis 7 multipart AOF directory plus manifest/config, or the deployed Dragonfly version's tested snapshot format; record queue prefix and scheduler state |
| Configuration | Git SHA, four image digests, manifests, non-secret settings, external service versions; separate `logbird-runtime`, `logbird-worker`, `logbird-migration` key inventories and encrypted references to preserved values |
| Platform | If k3s: control-plane datastore backup and saved server token; if Coolify: its separate instance backup plus saved encryption key and SSH recovery material |
| Receipt | Set ID, UTC fence/start/end times, last acknowledged canary IDs per QA project, artifact object IDs/sizes/checksums, off-host confirmation, operator and restore-test reference |

Platform snapshots do not substitute for the first three rows.
[Hetzner server backups exclude attached Volumes](https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/).
Keep application-consistent database backups even when host snapshots are enabled.
[K3s recovery](https://docs.k3s.io/datastore/backup-restore) needs its saved server token as well
as the correct datastore backup. Store token material privately without printing it into a receipt.
[Coolify instance backups](https://coolify.io/docs/core/backup-and-recovery/instance-backup)
cover the platform's own state; preserve its encryption key separately. They do not include
application volumes/databases. [Coolify database schedules](https://coolify.io/docs/databases/backups)
can cover supported database engines, but Redis/Dragonfly need their engine-specific procedure.

### Mandatory artifact and restore-correctness gates

**Keep production recovery fenced until both independent prerequisites pass.**

- **Runtime SQL packaging:** select a source revision containing the retention-SQL
  embedding fix merged from [PR #51](https://github.com/joodlab/logbird/pull/51) at
  `6be8ba00fdfeef54f24ea24cd434a8120c4310fe`, or an equivalent verified change.
  Source embedding is present on master; qualify the selected built artifacts separately. Record its
  exact accepted commit and the built API/worker image
  digests. Real expired-row retention and failed-run repair must execute through
  those exact digests and reconcile raw/derived values before release or recovery.
  A successful migration image/Job cannot establish API/worker runtime packaging.
- **Native-restore mutation versions:** [issue #75](https://github.com/joodlab/logbird/issues/75)
  records correct totals immediately after native restore, followed by doubled
  rollups after failed-retention repair. The restore investigation identified a restore-specific mismatch between preserved
  part mutation versions and newly allocated mutation IDs. Ordinary failed-run retry
  without restore was exact; this is a distinct restore gate, not proof that every
  retry doubles aggregates. [Live tracker #77](https://github.com/joodlab/logbird/issues/77)
  owns packaged restored-part guards, operator dry-run/normalization and normalized
  retry acceptance; #51 merged its verified portions at `6be8ba0`. Record the accepted
  fix/procedure revisions and image digests, then prove all three checkpoints below.
  **These live gates remain open.** Use #77's accepted procedure rather than inventing
  a mutation-version workaround; preserve original restored data and archives.

Record both fix links/revisions, image IDs/digests, engine version, backup set,
fixture IDs, materialized-view definitions/destinations, and `system.parts`
names/rows/data versions plus mutation status at every checkpoint. Retain original
backups and restored targets on mismatch. A completed mutation or RetentionRun
cannot close either gate when logical values disagree. Track them separately in
[OPS-03 and OPS-04](cloud-operations-gaps.md).

## Capture procedure

1. Acquire the release/backup lock. Verify target identities, destination access, free disk,
   last successful restore and previous recovery set. Abort on ambiguity; never reset a service.
   Set `RELEASE_REPO` to the absolute **private qualified release copy**: preserve
   the full repository-relative layout, including `deploy/k3s`, smoke tooling,
   dependencies and SQL files, with the approved real hostname and operator
   allowlist configured. A pristine checkout's example hostname/IPs are not usable.
   Include the automation host's actual egress /32 or /128 in that private allowlist.
   Keep private configuration outside Git; record source SHA and reviewed config
   hashes in the protected receipt. Do not depend on the backup host's directory.
2. Set the working directory before reusing relative bootstrap/fence paths:

   ```sh
   : "${RELEASE_REPO:?Absolute private qualified release copy}"
   cd "$RELEASE_REPO/deploy/k3s"
   ```

   Use only the [Ingress fence and drain commands](cloud-operations.md#fence-and-drain)
   for k3s (stop before its migration steps); prove external rejection before the boundary. Fence all direct writers,
   wait for acknowledged ingestion and active
   requests to finish, then drain/stop workers so retention cannot delete data during capture.
   Record pending/running jobs and `RetentionRun` state. Keep the API stopped while taking
   matched dumps; its own audit writes also count as writes. Complete pending ClickHouse
   mutations and record the fence time and table inventory. A request returning 202 promises
   durable events, so the fence must account for all acknowledged inserts.
3. Capture Postgres with a version-compatible client. Use a private `.pgpass`/`PGSERVICEFILE`
   (mode 0600) and `PGSERVICE=logbird-backup`; never put a connection URL/password in shell
   arguments or a shared log. The `pg_dumpall` line below is for a dedicated, authorized cluster
   only; on shared/managed Postgres, omit it and export only the application's authorized
   roles/grants using the administrator's procedure. Example on the backup host, with a unique
   private set directory:

   ```sh
   set -eu
   : "${RECOVERY_SET:?Set a unique private recovery directory}"
   test -d "$RECOVERY_SET"
   export PGSERVICE=logbird-backup
   umask 077
   pg_dump --format=custom --file="$RECOVERY_SET/postgres.dump"
   pg_restore --list "$RECOVERY_SET/postgres.dump" > "$RECOVERY_SET/postgres.contents"
   # Authorized cluster administrator only; encrypt this sensitive role artifact immediately.
   pg_dumpall --globals-only --file="$RECOVERY_SET/postgres-globals.sql"
   ```

   Confirm any globals export covered the intended dedicated cluster; never capture other
   tenants' globals. [Postgres dump guidance](https://www.postgresql.org/docs/17/backup-dump.html)
   distinguishes a database dump from cluster-wide roles and requires errors to be checked.
4. Configure a durable allowed backup disk as in [self-hosting](self-hosting.md#upgrades-and-backups),
   then use an authenticated ClickHouse client whose credentials are stored in a private config:

   ```sql
   BACKUP DATABASE logbird TO Disk('backups', 'unique-recovery-set.zip');
   ```

   Use a unique artifact name, check completion and preserve the access configuration or tested
   query-user provisioning inputs. Copy the completed archive off-host. Follow the deployed
   version's [ClickHouse backup/restore procedure](https://clickhouse.com/docs/operations/backup).
   Do not embed S3 keys in SQL text, query logs or tickets. A copy of live table directories is
   not this backup procedure. Schema-only or events-only copies omit important derived state.
5. With all queue writers/consumers stopped, use the engine's supported consistent persistence
   backup. For Redis 7, preserve the **entire multipart AOF directory and manifest**, not one
   `.aof` file. Stop the dedicated queue service cleanly if copying its persistence directory;
   shared services require their administrator's isolated snapshot procedure. Do not stop
   someone else's queue or issue FLUSHALL. [Redis persistence guidance](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
   describes multipart AOF. Do not use newer Redis backup commands on Redis 7. Dragonfly is a
   different engine; rehearse its deployed-version snapshot/restore rather than copying Redis
   AOF instructions.
6. Standardize the private set layout as `postgres.dump`, `clickhouse.zip`,
   `redis-aof.tar` (or an explicitly versioned Dragonfly snapshot), fixture manifests
   and config/platform artifacts. For the dedicated stopped Redis 7 source, create
   the relative archive with `tar -C <approved-redis-dir> -cf "$RECOVERY_SET/redis-aof.tar" appendonlydir`;
   inventory the AOF manifest/parts. Encrypt each artifact using the approved
   recovery recipient, for example `age -r "$RECOVERY_RECIPIENT" -o postgres.dump.age postgres.dump`.
   Keep plaintext/encrypted SHA256 lists in the independently protected receipt;
   the fetch example below expects these names, not an arbitrary tar of live files.
   Add the encrypted configuration/secret references and platform backup to the set. Hash and
   upload all artifacts; verify every object is readable from the recovery host, then record
   a complete-set receipt outside the affected host. A local success or upload attempt alone
   is insufficient. **Default nightly failure policy (owner may explicitly override
   in [OPS-03](cloud-operations-gaps.md#ops-03-recovery)):** if dump, encryption,
   upload or readback fails **before writer restart begins**, leave the previous
   good backup current, mark this attempt incomplete, and raise P1 **nightly backup
   missing** to the named primary/backup night rota. Reopen the unchanged live
   stores using the same reduced checks below; do not restore old data or advertise
   the partial set. The next attempt must not overwrite the last good set. A rota
   is required even with automation.

   For either a verified **unchanged nightly capture** or that pre-restart failure,
   bring any queue source stopped for capture back up using its qualified service
   procedure and verify persistence/dependency readiness first. Restore recorded
   baseline replica counts (API 2, worker 1), without changing images/configuration.
   Mark the restart phase durably **before** issuing the first restart/scale command:

   ```sh
   set -eu
   : "${RELEASE_REPO:?Absolute private qualified release copy}" "${PUBLIC_HOST:?Approved HTTPS hostname}"
   kubectl -n logbird scale deployment/logbird-server --replicas=2
   kubectl -n logbird scale deployment/logbird-worker --replicas=1
   kubectl -n logbird rollout status deployment/logbird-server --timeout=300s
   kubectl -n logbird rollout status deployment/logbird-worker --timeout=300s
   kubectl -n logbird rollout status deployment/logbird-app --timeout=300s
   kubectl -n logbird apply -k "$RELEASE_REPO/deploy/k3s/edge"
   # From ONE allowlisted operator host, using the dedicated QA canary project's
   # ingest/read keys already loaded privately into this process environment:
   : "${LOGBIRD_INGEST_KEY:?Canary ingest key}" "${LOGBIRD_READ_KEY:?Same canary project}"
   curl --fail --silent --show-error "https://$PUBLIC_HOST/readyz" --output /dev/null
   (cd "$RELEASE_REPO" && BASE_URL="https://$PUBLIC_HOST" \
     SMOKE_EMAIL= SMOKE_OTP= SMOKE_COOKIE= SMOKE_PROJECT_ID= \
     pnpm smoke:prod > /secure/receipt/nightly-smoke.txt)
   grep --fixed-strings --quiet 'PASS ingest + read (fictional smoke event retained)' /secure/receipt/nightly-smoke.txt
   kubectl -n logbird annotate ingress logbird \
     traefik.ingress.kubernetes.io/router.middlewares-
   ```

   This **reduced nightly reopen check** is readiness plus canary ingest/readback
   through the operator window, with mail/console options disabled. The script's
   normal optional SKIPs do not excuse a missing ingest/read PASS. Use the captured
   counts if the qualified release differs from 2/1; verify imageIDs/config stayed
   unchanged. Reserve the two-host bucket/spoof test for releases and edge/config
   changes, which require [full acceptance](cloud-ingress.md#two-ip-rate-limit-acceptance).
   Preserve any additional middleware when removing only the operator allowlist.
   A failure **after restart begins**, including readiness or canary failure,
   deletes the Ingress again, stays fenced and pages the rota. This applies also
   when reopening after a pre-restart backup failure. No blind retry or backup-
   success heartbeat is allowed. OPS-03 must implement/rehearse both failure
   branches, including process interruption at the restart boundary, before launch.
7. Send a success heartbeat **only after** off-host verification and successful reopen.
   Alert on failure, missed schedule and overdue restore drill. A reopened failed
   backup still has P1 **nightly backup missing** and the previous good set's age;
   reopening does not reset backup freshness. Never report a complete set when
   one store or credential is missing.

## Isolated restore drill

Run before launch, monthly thereafter and after changes to engines, schema, access provisioning
or backup tooling. Start the RTO clock at incident declaration, including destination provisioning,
downloads, decryption and validation. Never rehearse by importing into production.

1. Identify one complete set. Verify checksums, engine versions, decrypt permissions and all
   required secret references. Prepare **empty isolated** Postgres, ClickHouse and queue targets,
   isolated DNS/origin and a mail sink. No live production writer or worker may reach them.
2. Fetch and verify the private off-host set on the recovery host. The example uses
   an already configured rclone remote and age identity (credentials in protected
   files, no CLI keys). The trusted receipt must supply checksums independently of
   the downloaded objects; do not trust a manifest obtained from a compromised set.

   ```sh
   set -eu
   : "${RECOVERY_SET:?Private empty recovery directory}" "${SET_OBJECT:?Exact set object prefix}"
   umask 077
   rclone copy "logbird-recovery:$SET_OBJECT" "$RECOVERY_SET/encrypted"
   # Verify encrypted hashes against the independently retained receipt first.
   (cd "$RECOVERY_SET/encrypted" && sha256sum --check /secure/receipt/encrypted.sha256)
   age --decrypt -i /secure/recovery.agekey -o "$RECOVERY_SET/postgres.dump" "$RECOVERY_SET/encrypted/postgres.dump.age"
   age --decrypt -i /secure/recovery.agekey -o "$RECOVERY_SET/clickhouse.zip" "$RECOVERY_SET/encrypted/clickhouse.zip.age"
   age --decrypt -i /secure/recovery.agekey -o "$RECOVERY_SET/redis-aof.tar" "$RECOVERY_SET/encrypted/redis-aof.tar.age"
   (cd "$RECOVERY_SET" && sha256sum --check /secure/receipt/plaintext.sha256)
   ```

   Restore only the intended Postgres roles/grants. Use a **separate restore service**
   pointing at the new target, not the capture profile. Verify its identity against
   the approved target receipt before the restoring command:

   ```sh
   export PGSERVICEFILE=/secure/restore-pg-service.conf PGSERVICE=logbird-restore
   psql -X -v ON_ERROR_STOP=1 -c 'SELECT current_database(), inet_server_addr(), version();'
   # Stop if this is not the approved new target. Credentials stay in private .pgpass.
   pg_restore --exit-on-error --no-owner --dbname='service=logbird-restore' "$RECOVERY_SET/postgres.dump"
   ```

   Reconcile ownership/grants explicitly with the provisioned
   application role; `--no-owner` alone does not do that. Do not import other tenants' globals
   or use `--clean` against populated/shared databases. Run the inventory below and
   compare it with the set's capture-time receipt.
3. Configure an allowed `backups` disk on the **fresh isolated** ClickHouse server
   using the accepted release's
   [merged backup-disk config](../config/clickhouse-backups.xml).
   Pin the accepted revision and deployed engine version, bind the durable staging
   directory to that config's path, and restart only the isolated server. Inspect
   `system.disks` to verify name/path; do not copy the source server's data directories.
   On the new ClickHouse host (example disk path from that config):

   ```sh
   # Transfer the checksum-verified archive through the approved private channel first.
   sudo install -o clickhouse -g clickhouse -m 0600 "$RECOVERY_SET/clickhouse.zip" \
     /var/lib/clickhouse/backups/recovery-set.zip
   clickhouse-client --config-file /secure/isolated-clickhouse.xml --query \
     "RESTORE DATABASE logbird FROM Disk('backups', 'recovery-set.zip')"
   ```

   Use an empty destination and confirm `system.backups` reports RESTORED. Never use
   `allow_non_empty_tables` to force recovery over surviving data.
   Keep database name and materialized-view destinations consistent. Restore/reprovision access
   policies using the **preserved** query password and that release's provisioning command.
   Before any worker starts, perform checkpoint A below: raw event IDs/payloads,
   logical aggregates and view destinations. For row-policy isolation, execute the
   [Query/SQL denial and cross-project acceptance](deployment.md#acceptance) using
   the restricted query user and a second fictional project; main-user admin reads
   are not isolation proof. Keep public access fenced.
4. Restore the queue persistence with its version-matched engine and original `{logbird}` prefix.
   For the selected Redis 7 path, stop only the isolated Redis service and inspect
   the trusted archive listing for traversal/absolute paths before extraction. The
   capture archive must contain the whole relative `appendonlydir/` and manifest:

   ```sh
   tar --list --file "$RECOVERY_SET/redis-aof.tar"
   # After validating paths and confirming /srv/logbird-restore/redis is empty:
   sudo tar --extract --file "$RECOVERY_SET/redis-aof.tar" --directory /srv/logbird-restore/redis
   sudo chown -R redis:redis /srv/logbird-restore/redis
   # Dedicated isolated systemd service, with dir=/srv/logbird-restore/redis,
   # appendonly yes and appenddirname appendonlydir in its version-pinned config:
   sudo systemctl start redis-logbird-restore
   : "${RESTORE_REDIS_HOST:?Isolated target}" "${RESTORE_REDIS_PORT:?Isolated TLS port}"
   redis-cli -h "$RESTORE_REDIS_HOST" -p "$RESTORE_REDIS_PORT" \
     --tls --cacert /secure/redis-ca.pem --askpass INFO persistence
   ```

   Supply the actual isolated host/port/user and TLS config, check loading completes
   without AOF errors and record queue job counts/statuses. For Dragonfly, use the
   deployed version's tested snapshot recipe instead; Redis AOF is not interchangeable.
   Keep the worker stopped while inspecting pending/failed/running jobs. Reconcile jobs with
   restored Postgres projects and `RetentionRun` rows; review orphan/stale jobs before enabling
   consumers. Never restore queues from a newer boundary than the databases or silently discard
   jobs to make health green. Stale running retention leases should recover through the app's
   documented recovery path; prove it using a fictional project.
5. Start the recorded app/API image digests against only these targets, with email redirected
   to the sink and code logging disabled. Use the original secrets securely where needed to
   verify compatibility. Keep the drill origin/credentials inaccessible to real users and
   isolate it from production cookies and integrations.
6. Prove a fictional user/workspace/project, stored key compatibility, denied cross-project reads,
   known event IDs/payloads, Query/SQL restrictions and checkpoint A. Confirm no event acknowledged
   before the backup fence is absent from that boundary. Start the exact qualified worker digest
   and prove scheduler registration, real expired-row retention, and failed/abandoned-run repair.
   Complete checkpoint B, then repeat the repair and complete checkpoint C. Do not reopen traffic
   or certify recovery before all checkpoints and both artifact gates pass.
7. Record actual recovered boundary/RPO, elapsed RTO, artifact IDs, checks, omissions and operator.
   Capture unexpected reappearing users/projects/deleted data: restoring an older set can resurrect
   removals. Reapply the verified deletion inventory **before** production traffic; if that
   inventory is unavailable, keep access fenced and escalate. Expired retention data must not
   become customer-visible merely because a backup contains it.
8. Stop all drill processes, revoke only drill-specific credentials where authorized, and remove
   only verified drill-owned resources after the evidence is retained. Do not rotate/delete
   existing production keys. Keep the source recovery artifacts unchanged.

### Logical aggregate checkpoints (A, B, C)

Use a version-pinned fictional fixture containing both surviving and expired events,
all four entity kinds, multiple minute buckets and attribute keys. Include restored
parts whose `data_version` exceeds the newly allocated mutation versions, as in #75.
Keep each fixture entity's type/name constant so `anyLast` labels have an exact
expected value independent of background merge order.
Run a fresh-storage/no-restore failed-retry control separately to distinguish the
restore defect. Compare complete grouped values to an independent aggregation of
the expected surviving raw events; physical aggregate-table row counts vary with
background merges and cannot establish correctness.

| Check | A: immediately after restore, workers stopped | B: after retention and failed/abandoned-run repair | <local-path>fter repeating repair |
| --- | --- | --- | --- |
| Raw events | Backup-boundary IDs/payloads and survival policy match the fixture manifest | Expired IDs absent; survivor IDs/payloads exact; no missing acknowledged survivors | Same survivors as B, no new rows or resurrection |
| `events_by_minute` | `sum(events)` by the full minute/environment/action/outcome/actor/executor key matches raw events | Recompute the same map from survivors and compare every key/value | Identical logical map to B; no doubled counts |
| `entities` | Group `(project_id,kind,entity_id)`: summed events, min first_seen, max last_seen and fixture labels agree with raw actor/tenant/executor/target expansion | Same invariants against survivors; expired-only entities gone | Same counts/extrema/fixture labels as B |
| `attribute_keys` | Per project/key: summed count and max last_seen match raw map-key expansion; merged samples belong to the fixture's permitted values | Same invariants against survivors; expired-only keys gone | Same logical counts/extrema; merged samples remain valid |
| Conditional `event_ids` / `event_ids_mv` (006 or 007) | Select from migration inventory plus actual engine: 006 logical FINAL map; 007 distinct ID/tuple sets and oldest-tuple lookup; record physical multiplicity and MV destination | Compare the independently predicted surviving maps/tuples under this release's retention rules; explain any approved rebuild change | Same logical result as B and no unexplained per-tuple physical growth against accepted B; existing 007 backfill overlap is not corruption |
| Views and diagnostics | Saved materialized-view definitions and `TO` destinations match this schema; record part versions and pending mutation context | Verify definitions/destinations unchanged; record completed/failed mutations and receipt alongside logical values | Repeat diagnostics; completion alone is insufficient |

Checkpoint A covers the restored boundary before retention removes expired fixture
events; B/C cover the independently computed survivor boundary. Do not compare
only grand totals, run `OPTIMIZE FINAL` to conceal a mismatch, or delete/recreate
restored tables as an unverified workaround. Preserve evidence and follow #75's
accepted #77 fix/procedure if any check fails. Measure recovery objectives only after correctness.
Use #77's built-image fixture/harness to exercise repair twice;
a completed no-op scheduler pass is not repeated-repair evidence.

### Executable comparison and fixture manifest

Reference checks: [raw/minute/entities/attributes SQL](cloud-dr-checks.sql) and
[006 receipt SQL](cloud-dr-event-ids-006.sql), [007 receipt SQL](cloud-dr-event-ids-007.sql)
and [physical growth check](cloud-dr-receipt-growth.sql). **Each EXCEPT ALL in both
directions must return an empty result; every query must succeed.** `throwIf` guards
reject empty project fixtures and expected/actual counts that differ from the
independently recorded manifest. Successful guards use `FORMAT Null` so they do not
pollute the differences output. Query errors,
missing expected files or zero fixtures are failures. The receipt also records
expected nonzero raw/survivor counts, query count, exit status and checkpoint.
SimpleAggregateFunction counts use `sum`; attribute `samples` uses `groupUniqArrayMerge`.

Use only the small version-pinned QA fixture on isolated targets. The existing
[self-host harness](../scripts/selfhost-smoke.mjs)
is a reference input, not cloud acceptance evidence. Follow #77 for the accepted built-image
guard/repair scenario. Keep constant labels per entity and at most five distinct
values per attribute key so the reference sample set is deterministic.

Before capturing the fictional source, export the normalized fixture rows using
the private client config; retain the API input manifest, exact cutoff and ID list
independently of the restored target. Store these **encrypted in the recovery set**:

**Fixture gap rule:** record capture time, retentionDays, maximum supported set age
and maximum drill duration, all in UTC. At capture, expired events must be older
than retentionDays **plus maximum set age** (add a safety margin); survivors must
remain newer than the wall-clock retention cutoff through the latest permitted
drill finish. For example, for 90-day retention, a 35-day maximum set age and a
one-day drill budget, use expired events 200 days old and survivors one day old.
Keep the frozen manifest split strictly between the two groups. If the set exceeds
that age or the drill overruns the gap, stop and replace the fixture/set; do not
change expected survivors from the restored result or confuse fixture expiry with #75.

At B **and C**, bind the exact completed repair receipt ID and assert its real
`RetentionRun.cutoff` lies in `(max expired timestamp, min survivor timestamp]`.
Use the protected isolated Postgres connection and `psql -X -v ON_ERROR_STOP=1`
with `-v QA_RUN=... -v QA_PROJECT=... -v MAX_EXPIRED=... -v MIN_SURVIVOR=...`:

```sql
SELECT 1 / CASE WHEN count(*) = 1 AND bool_and(
  status = 'completed' AND "projectId" = :'QA_PROJECT'
  AND cutoff > (:'MAX_EXPIRED'::timestamptz AT TIME ZONE 'UTC')
  AND cutoff <= (:'MIN_SURVIVOR'::timestamptz AT TIME ZONE 'UTC')
) THEN 1 ELSE 0 END AS fixture_cutoff_verified
FROM "RetentionRun" WHERE id = :'QA_RUN';
```

Run the SQL via psql stdin/file so psql variables expand. A missing/wrong receipt,
project, status or out-of-gap cutoff errors instead of passing. Retain the receipt
ID/cutoff and timestamp bounds; only then compare against the precomputed B/C file.

```sh
clickhouse-client --config-file /secure/source-clickhouse.xml --param_fixture_project="$QA_PROJECT" \
  --query 'SELECT * FROM logbird.events WHERE project_id={fixture_project:String} ORDER BY event_id FORMAT JSONEachRow' \
  > "$RECOVERY_SET/fixture-A.jsonl"
clickhouse-client --config-file /secure/source-clickhouse.xml --param_fixture_project="$QA_PROJECT" \
  --param_cutoff="$FIXTURE_CUTOFF" --query \
  "SELECT * FROM logbird.events WHERE project_id={fixture_project:String} AND timestamp >= {cutoff:DateTime64(3,'UTC')} ORDER BY event_id FORMAT JSONEachRow" \
  > "$RECOVERY_SET/fixture-BC.jsonl"
# Save counts, cutoff, SHA256, input event IDs, expected receipt map and schema/column order.
```

At A load `fixture-A.jsonl`; at B/C load the precomputed `fixture-BC.jsonl`. In a
**single** clickhouse-client session create a temporary expected table, load it from
the client-side file, then execute all four comparisons:

```sh
set -eu
: "${RELEASE_REPO:?Absolute qualified release checkout}" "${EXPECTED_ROWS:?Checkpoint file path}"
: "${QA_PROJECT:?Isolated QA project ID}" "${MANIFEST_COUNT:?Nonzero checkpoint count from trusted receipt}"
DR_SQL="$RELEASE_REPO/docs/cloud-dr-checks.sql"
sha256sum "$DR_SQL" > /secure/receipt/verification-sql.sha256
# Match these hashes to the accepted revision's independently trusted receipt.
test "$(wc -l < "$EXPECTED_ROWS")" -eq "$MANIFEST_COUNT"
clickhouse-client --config-file /secure/isolated-clickhouse.xml \
  --param_fixture_project="$QA_PROJECT" --param_manifest_count="$MANIFEST_COUNT" --multiquery --query "
  CREATE TEMPORARY TABLE expected_events ENGINE=Memory AS SELECT * FROM logbird.events WHERE 0;
  INSERT INTO expected_events FROM INFILE '$EXPECTED_ROWS' FORMAT JSONEachRow;
  $(cat "$DR_SQL")" > /secure/receipt/checkpoint-differences.txt
test ! -s /secure/receipt/checkpoint-differences.txt
```

Use an operator-controlled path without quotes/newlines; this is a small fixture,
not an in-memory copy of customer data. Validate file count/hash against the receipt
before execution. Receipt selection and expected-data loading are separate below.

### Receipt profile from migration inventory and engine

Record the inventory and actual table engines **before exporting**, and again on
restore. Master `6be8ba0` contains migrations 001-005 only; receipt tables are
conditional on [#62 at 97b03c2](https://github.com/joodlab/logbird/blob/97b03c2dd710f4fa805c525c57fc7b8395e2aa94/packages/clickhouse/migrations/007_event_ids_merge_tree.sql).
Use the authenticated source/restore client configs, never change the shared stores:

```sql
SELECT name,applied_at FROM logbird.migrations ORDER BY name;
SELECT name,engine,create_table_query FROM system.tables
WHERE database='logbird'
  AND name IN ('event_ids','event_ids_mv','event_ids_v2','event_ids_v2_mv','event_ids_v3','event_ids_v3_mv')
ORDER BY name;
```

`event_ids_v2*` are the temporary objects of 007 and `event_ids_v3*` those of 008.
Any of the four left behind means an interrupted online migration.

| Recorded inventory and observed state | Export and verification |
| --- | --- |
| 001-005; no event_ids objects | Record absence; skip receipt SQL only |
| 006 present, 007 absent; event_ids is ReplacingMergeTree; no v2/v3 leftovers | Profile 006: export logical map with FINAL; use `cloud-dr-event-ids-006.sql` |
| 006 and completed 007 present (with or without completed 008/009); event_ids is plain MergeTree; no v2/v3 leftovers | Profile 007+: no FINAL; export distinct full tuples; use `cloud-dr-event-ids-007.sql`. 008 changes only `index_granularity` and 009 adds a skip index; neither changes the logical tuple profile |
| Missing/unknown engine, inventory mismatch, or any interrupted `event_ids_v2`, `event_ids_v2_mv`, `event_ids_v3` or `event_ids_v3_mv` object | Stop; preserve evidence and use the accepted migration recovery procedure. Do not guess a profile or rewrite inventory |

Both scripts independently reject an engine/inventory mismatch, and both reject
v2/v3 leftovers, so final verification fails closed even if this step is skipped. Save/review the MV
`TO` destination with the schema receipt. On the fictional **source**, choose the
matching export, keeping `project_id,event_id,received_at,timestamp` column order:

```sql
-- 006 / ReplacingMergeTree only:
SELECT project_id,event_id,received_at,timestamp FROM logbird.event_ids FINAL
WHERE project_id={fixture_project:String} ORDER BY project_id,event_id FORMAT JSONEachRow;
-- 007 / plain MergeTree only, including legacy tuples and overlapping backfill:
SELECT DISTINCT project_id,event_id,received_at,timestamp FROM logbird.event_ids
WHERE project_id={fixture_project:String}
ORDER BY project_id,event_id,received_at,timestamp FORMAT JSONEachRow;
-- Both: physical multiplicity is recorded separately, never assumed to be one.
SELECT project_id,event_id,received_at,timestamp,count() AS physical_rows
FROM logbird.event_ids WHERE project_id={fixture_project:String}
GROUP BY project_id,event_id,received_at,timestamp
ORDER BY project_id,event_id,received_at,timestamp FORMAT JSONEachRow;
```

Save A and independently predicted B/C receipt files under the release's recorded
retention/rebuild rules and fixture gap, including any approved reinsertions. Do not
blindly filter a 006 FINAL map if legacy fallback/rebuild can replace a pointer.
For 007, the tuple file is distinct: record both its tuple count and distinct
`(project_id,event_id)` count. The canonical lookup is the oldest surviving tuple
by `received_at,timestamp,event_id`, matching
[existingEventIdentities](https://github.com/joodlab/logbird/blob/97b03c2dd710f4fa805c525c57fc7b8395e2aa94/packages/clickhouse/src/identity.ts#L115).
The 007 script compares the ID set, complete distinct tuples and this lookup;
physical duplicates from backfill do not change those logical results.

At A, the physical ceiling comes from the independently recorded source. At B use
that ceiling projected under retention plus explicitly approved rebuild changes;
record each explanation. After B passes all logical and growth checks, retain its
observed per-tuple multiplicity as C's ceiling. C must not grow beyond accepted B
without a specific, reviewed explanation. Replacing merges may reduce counts.
Save physical snapshots at all phases separately from logical difference files;
never generate a logical expected map from the restored result.

Load both expected files in one client session. `MANIFEST_RECEIPT_COUNT` is the
006 logical-map row count or 007 distinct full-tuple count; `MANIFEST_RECEIPT_ID_COUNT`
is 007's distinct ID count. Counts/hashes must come from the trusted receipt:

```sh
set -eu
: "${RELEASE_REPO:?Absolute qualified checkout}" "${RECEIPT_PROFILE:?006 or 007 from inventory AND engine}"
case "$RECEIPT_PROFILE" in
  006|007) RECEIPT_SQL="$RELEASE_REPO/docs/cloud-dr-event-ids-$RECEIPT_PROFILE.sql" ;;
  *) echo 'Stop: invalid receipt profile' >&2; exit 1 ;;
esac
GROWTH_SQL="$RELEASE_REPO/docs/cloud-dr-receipt-growth.sql"
sha256sum "$RECEIPT_SQL" "$GROWTH_SQL" >> /secure/receipt/verification-sql.sha256
: "${EXPECTED_RECEIPTS:?Verified tuple/map file}" "${MANIFEST_RECEIPT_COUNT:?Nonzero count}"
: "${EXPECTED_MULTIPLICITY:?Verified phase ceiling file}" "${MANIFEST_MULTIPLICITY_COUNT:?Nonzero tuple count}"
: "${QA_PROJECT:?Fixture project}" "${MANIFEST_RECEIPT_ID_COUNT:?Distinct ID count; same as row count for 006}"
test "$(wc -l < "$EXPECTED_RECEIPTS")" -eq "$MANIFEST_RECEIPT_COUNT"
test "$(wc -l < "$EXPECTED_MULTIPLICITY")" -eq "$MANIFEST_MULTIPLICITY_COUNT"
clickhouse-client --config-file /secure/isolated-clickhouse.xml \
  --param_fixture_project="$QA_PROJECT" --param_manifest_receipt_count="$MANIFEST_RECEIPT_COUNT" \
  --param_manifest_receipt_id_count="$MANIFEST_RECEIPT_ID_COUNT" \
  --param_manifest_multiplicity_count="$MANIFEST_MULTIPLICITY_COUNT" --multiquery --query "
  CREATE TEMPORARY TABLE expected_receipts (
    project_id String,event_id String,received_at DateTime64(3,'UTC'),timestamp DateTime64(3,'UTC'));
  CREATE TEMPORARY TABLE expected_receipt_multiplicity (
    project_id String,event_id String,received_at DateTime64(3,'UTC'),timestamp DateTime64(3,'UTC'),physical_rows UInt64);
  INSERT INTO expected_receipts FROM INFILE '$EXPECTED_RECEIPTS' FORMAT JSONEachRow;
  INSERT INTO expected_receipt_multiplicity FROM INFILE '$EXPECTED_MULTIPLICITY' FORMAT JSONEachRow;
  $(cat "$RECEIPT_SQL")
  $(cat "$GROWTH_SQL")" > /secure/receipt/receipt-differences.txt
test ! -s /secure/receipt/receipt-differences.txt
```

Nonempty results or any failed guard keep recovery fenced. Record the selected
profile/engine, SQL hashes, query counts and physical multiplicity before/after B/C.

### Postgres inventory queries

Run at capture and restore through the protected PGSERVICE connection and compare
the result files; no tokens, hashes, user emails or row payloads are selected:

```sql
SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at
FROM "_prisma_migrations" ORDER BY migration_name;
SELECT 'organization' AS relation, count(*) FROM organization
UNION ALL SELECT 'Project', count(*) FROM "Project"
UNION ALL SELECT 'user', count(*) FROM "user"
UNION ALL SELECT 'member', count(*) FROM member
UNION ALL SELECT 'ApiKey', count(*) FROM "ApiKey"
UNION ALL SELECT 'SavedView', count(*) FROM "SavedView"
UNION ALL SELECT 'RetentionRun', count(*) FROM "RetentionRun";
SELECT id, "organizationId", "retentionDays" FROM "Project" ORDER BY id;
SELECT id, "projectId", status, cutoff, "heartbeatAt", "finishedAt"
FROM "RetentionRun" ORDER BY id;
SELECT table_schema, table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;
```

Compare receipt status changes intentionally at B/C, and reconcile project IDs
against ClickHouse and the queue. Counts alone do not prove settings/keys survived:
also run the fictional login, stored-key read/ingest, retention-policy and deletion
checks from the fixture manifest.

## Cut over to restored targets

Only the authorized incident operator executes these commands against the approved
recovery cluster. Keep the source disks/archives and rollback configuration intact.
Complete the isolated drill above, including queue reconciliation and checkpoints
B/C using its qualified isolated worker, then stop that worker. Until those pass,
production's regular worker Deployment stays at zero. This procedure does not
bypass #75/#77's accepted recovery/artifact gates.

1. Retain the public fence and stop the regular production consumers:

   ```sh
   set -eu
   : "${RELEASE_REPO:?Absolute private qualified release copy}"
   cd "$RELEASE_REPO/deploy/k3s"
   kubectl -n logbird delete ingress logbird --ignore-not-found --wait=true
   kubectl -n logbird scale deployment/logbird-worker --replicas=0
   kubectl -n logbird wait --for=delete pod -l app.kubernetes.io/name=logbird-worker --timeout=330s
   ```

   Fence every other writer and stop the old API as in the release drain. Confirm
   all targets are the accepted restored stores, not the failed source.
2. Prepare three protected JSON merge-patch files containing **only `stringData`**
   for replaced endpoints, using the existing scoped Secret inventories:

   | Secret / protected patch | Permitted endpoint keys, only when replaced |
   | --- | --- |
   | `logbird-runtime` / `/secure/cutover/runtime-endpoints.json` | `DATABASE_URL`, `CLICKHOUSE_URL`, `REDIS_URL` |
   | `logbird-worker` / `/secure/cutover/worker-endpoints.json` | `DATABASE_URL`, `CLICKHOUSE_URL`, `REDIS_URL` |
   | `logbird-migration` / `/secure/cutover/migration-endpoints.json` | `DATABASE_URL`, `CLICKHOUSE_URL` |

   Omit unchanged endpoint keys. This is **not credential rotation**: retain URL
   credentials, database names and required connection options while changing only
   approved host/port/transport endpoints. Preserve every other key/value, including
   `BETTER_AUTH_SECRET`, SMTP credentials, ClickHouse user/password and restricted
   query password. Do not recreate whole Secrets from a different role's file.
   Apply the privately reviewed patches without printing their contents:

   ```sh
   kubectl -n logbird patch secret logbird-runtime --type=merge --patch-file=/secure/cutover/runtime-endpoints.json
   kubectl -n logbird patch secret logbird-worker --type=merge --patch-file=/secure/cutover/worker-endpoints.json
   kubectl -n logbird patch secret logbird-migration --type=merge --patch-file=/secure/cutover/migration-endpoints.json
   # Key names only; compare with the protected pre-cutover inventories.
   kubectl -n logbird get secret logbird-runtime logbird-worker logbird-migration \
     -o go-template='{{range .items}}{{.metadata.name}}{{"\n"}}{{range $key, $value := .data}}{{$key}}{{"\n"}}{{end}}{{end}}'
   ```

   Verify inventories match, preserved credential values compare equal in the
   protected operator process (no values in logs), and endpoints agree across roles.
3. Secret references are read at Pod start: roll app/API to the accepted digests
   and restored endpoints, keeping the regular worker at zero:

   ```sh
   kubectl -n logbird rollout restart deployment/logbird-server deployment/logbird-app
   kubectl -n logbird scale deployment/logbird-server --replicas=2
   kubectl -n logbird rollout status deployment/logbird-server --timeout=300s
   kubectl -n logbird rollout status deployment/logbird-app --timeout=300s
   ```

   Through the local port-forward, recheck logical values on the production-bound
   targets against the accepted checkpoint C expectations (do not reuse pre-purge
   A expectations after B/C). Do this before any regular worker starts. Confirm
   queue/RetentionRun reconciliation and the isolated worker's B/C receipts cover these exact stores,
   schema and digests; if not, stop and repeat the isolated acceptance under the
   fence. Do not start an unqualified worker to make readiness green.
4. Reapply the verified deletion inventory and recheck retention/tenant isolation
   before customer access. If absent or incomplete, remain fenced. Once queue
   reconciliation and B/C pass, start the regular worker on its updated Secret:

   ```sh
   kubectl -n logbird scale deployment/logbird-worker --replicas=1
   kubectl -n logbird rollout status deployment/logbird-worker --timeout=300s
   ```

   Apply the [operator-only edge window](cloud-ingress.md#fence-and-operator-acceptance-window),
   run full release acceptance (including two-source auth buckets), and only then
   [unfence](cloud-ingress.md#unfence-and-refence). On failure refence and page;
   keep recovered data and evidence for investigation. Record endpoint changes,
   checkpoint receipts, running imageIDs and operator approval in the incident log.

## Incident and rollback decision

For lost/corrupt storage or incompatible migration: fence writes, declare the affected component
on the independent status page, preserve original disks/logs, choose a complete set and restore
to new targets. Accept any loss between the backup boundary and incident explicitly; do not
claim an unmeasured RPO of zero. Reconcile IDs/projects, deletion inventory and retention before
[cutting over to restored targets](#cut-over-to-restored-targets), then reopen traffic
under observation only after that ordered acceptance.

For an application-only failure with compatible schema, pin the previous digests and configuration
and validate them against current data. The release lock, evidence and acceptance gates still
apply. When partial migrations or store alignment are uncertain, preserve state and investigate;
running older code or mixing separately timed backups is not an automatic recovery strategy.
