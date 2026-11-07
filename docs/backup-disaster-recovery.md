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
  embedding fix in [PR #51](https://github.com/joodlab/logbird/pull/51), or an equivalent
  verified change. Inspect the actual merged portion for embedded SQL. Record its
  exact accepted commit and the built API/worker image
  digests. Real expired-row retention and failed-run repair must execute through
  those exact digests and reconcile raw/derived values before release or recovery.
  A successful migration image/Job cannot establish API/worker runtime packaging.
- **Native-restore mutation versions:** [issue #75](https://github.com/joodlab/logbird/issues/75)
  records correct totals immediately after native restore, followed by doubled
  rollups after failed-retention repair. The self-host investigation and owner's
  2026-11-07 root-cause update identify a restore-specific mismatch between preserved
  part mutation versions and newly allocated mutation IDs. Ordinary failed-run retry
  without restore was exact; this is a distinct restore gate, not proof that every
  retry doubles aggregates. [Live tracker #77](https://github.com/joodlab/logbird/issues/77)
  owns packaged restored-part guards, operator dry-run/normalization and normalized
  retry acceptance; #51 can merge only its verified portions. Record the accepted
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
2. Use only the [Ingress fence and drain commands](cloud-operations.md#fence-and-drain)
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
   is insufficient. Restart the recorded qualified API/worker digests, prove readiness
   and [operator-only acceptance](cloud-ingress.md#fence-and-operator-acceptance-window),
   then [unfence explicitly](cloud-ingress.md#unfence-and-refence).
7. Send a success heartbeat **after** off-host verification, and alert on failure, missed schedule
   and overdue restore drill. Do not report a complete set when one store or credential is missing.

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
   [backup-disk config in #51](https://github.com/joodlab/logbird/blob/1d10c692e421b5d33cc675da91fda8a5e55b2fe6/config/clickhouse-backups.xml).
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
   logical aggregates, view destinations and row-policy isolation. Keep public access fenced.
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

| Check | A: immediately after restore, workers stopped | B: after retention and failed/abandoned-run repair | C: after repeating repair |
| --- | --- | --- | --- |
| Raw events | Backup-boundary IDs/payloads and survival policy match the fixture manifest | Expired IDs absent; survivor IDs/payloads exact; no missing acknowledged survivors | Same survivors as B, no new rows or resurrection |
| `events_by_minute` | `sum(events)` by the full minute/environment/action/outcome/actor/executor key matches raw events | Recompute the same map from survivors and compare every key/value | Identical logical map to B; no doubled counts |
| `entities` | Group `(project_id,kind,entity_id)`: summed events, min first_seen, max last_seen and fixture labels agree with raw actor/tenant/executor/target expansion | Same invariants against survivors; expired-only entities gone | Same counts/extrema/fixture labels as B |
| `attribute_keys` | Per project/key: summed count and max last_seen match raw map-key expansion; merged samples belong to the fixture's permitted values | Same invariants against survivors; expired-only keys gone | Same logical counts/extrema; merged samples remain valid |
| Conditional `event_ids` / `event_ids_mv` (migration 006) | One logical receipt per distinct project/event ID in the capture fixture, with exact received_at/timestamp and correct MV destination | One receipt per expected surviving ID, reflecting this release's receipt-retention policy; no duplicate MV population | Same receipt map as B; repeated repair must not add receipts |
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
[conditional event-ID SQL](cloud-dr-event-ids.sql). **Each EXCEPT ALL in both
directions must return an empty result; every query must succeed.** Query errors,
missing expected files or zero fixtures are failures. The receipt also records
expected nonzero raw/survivor counts, query count, exit status and checkpoint.
SimpleAggregateFunction counts use `sum`; attribute `samples` uses `groupUniqArrayMerge`.

Use only the small version-pinned QA fixture on isolated targets. The existing
[self-host harness](https://github.com/joodlab/logbird/blob/1d10c692e421b5d33cc675da91fda8a5e55b2fe6/scripts/selfhost-smoke.mjs)
and [dated evidence](https://github.com/joodlab/logbird/blob/1d10c692e421b5d33cc675da91fda8a5e55b2fe6/docs/verification/selfhost-2026-11-07.json)
are reference inputs, not a cloud PASS. Follow #77 for the accepted built-image
guard/repair scenario. Keep constant labels per entity and at most five distinct
values per attribute key so the reference sample set is deterministic.

Before capturing the fictional source, export the normalized fixture rows using
the private client config; retain the API input manifest, exact cutoff and ID list
independently of the restored target. Store these **encrypted in the recovery set**:

```sh
clickhouse-client --config-file /secure/source-clickhouse.xml --param_fixture_project="$QA_PROJECT" \
  --query 'SELECT * FROM logbird.events WHERE project_id={fixture_project:String} ORDER BY event_id FORMAT JSONEachRow' \
  > "$RECOVERY_SET/fixture-A.jsonl"
clickhouse-client --config-file /secure/source-clickhouse.xml --param_fixture_project="$QA_PROJECT" \
  --param_cutoff="$FIXTURE_CUTOFF" --query \
  'SELECT * FROM logbird.events WHERE project_id={fixture_project:String} AND timestamp >= {cutoff:DateTime64(3)} ORDER BY event_id FORMAT JSONEachRow' \
  > "$RECOVERY_SET/fixture-BC.jsonl"
# Save counts, cutoff, SHA256, input event IDs, expected receipt map and schema/column order.
```

At A load `fixture-A.jsonl`; at B/C load the precomputed `fixture-BC.jsonl`. In a
**single** clickhouse-client session create a temporary expected table, load it from
the client-side file, then execute all four comparisons:

```sh
set -eu
: "${EXPECTED_ROWS:?Checkpoint file path}" "${QA_PROJECT:?Isolated QA project ID}"
clickhouse-client --config-file /secure/isolated-clickhouse.xml \
  --param_fixture_project="$QA_PROJECT" --multiquery --query "
  CREATE TEMPORARY TABLE expected_events ENGINE=Memory AS SELECT * FROM logbird.events WHERE 0;
  INSERT INTO expected_events FROM INFILE '$EXPECTED_ROWS' FORMAT JSONEachRow;
  $(cat docs/cloud-dr-checks.sql)" > /secure/receipt/checkpoint-differences.txt
test ! -s /secure/receipt/checkpoint-differences.txt
```

Use an operator-controlled path without quotes/newlines; this is a small fixture,
not an in-memory copy of customer data. Validate file count/hash against the receipt
before execution. For migration 006, export `project_id,event_id,received_at,timestamp`
from source `event_ids FINAL` and filter its B/C map under the release's recorded
receipt-retention policy. Load the corresponding private JSONEachRow file into
`expected_receipts`, then execute its comparisons in the same session:

```sh
: "${EXPECTED_RECEIPTS:?Checkpoint-specific verified file path}"
clickhouse-client --config-file /secure/isolated-clickhouse.xml \
  --param_fixture_project="$QA_PROJECT" --multiquery --query "
  CREATE TEMPORARY TABLE expected_receipts (
    project_id String, event_id String, received_at DateTime64(3,'UTC'), timestamp DateTime64(3,'UTC'));
  INSERT INTO expected_receipts FROM INFILE '$EXPECTED_RECEIPTS' FORMAT JSONEachRow;
  $(cat docs/cloud-dr-event-ids.sql)" > /secure/receipt/receipt-differences.txt
test ! -s /secure/receipt/receipt-differences.txt
```

Record both physical duplicate diagnostics and logical receipt agreement; never
unconditionally execute a query against a table absent from the migration inventory.

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

## Incident and rollback decision

For lost/corrupt storage or incompatible migration: fence writes, declare the affected component
on the independent status page, preserve original disks/logs, choose a complete set and restore
to new targets. Accept any loss between the backup boundary and incident explicitly; do not
claim an unmeasured RPO of zero. Reconcile IDs/projects, deletion inventory and retention before
switching configuration, then run acceptance and reopen traffic gradually under observation.

For an application-only failure with compatible schema, pin the previous digests and configuration
and validate them against current data. The release lock, evidence and acceptance gates still
apply. When partial migrations or store alignment are uncertain, preserve state and investigate;
running older code or mixing separately timed backups is not an automatic recovery strategy.
