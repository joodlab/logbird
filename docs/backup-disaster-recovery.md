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
PITR and ClickHouse backups are not automatically transactionally aligned.

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
| Configuration | Git SHA, four image digests, manifests, non-secret settings, external service versions and encrypted references to existing secrets/keys |
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

## Capture procedure

1. Acquire the release/backup lock. Verify target identities, destination access, free disk,
   last successful restore and previous recovery set. Abort on ambiguity; never reset a service.
2. Fence public writes and all direct writers, wait for acknowledged ingestion and active
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
6. Add the encrypted configuration/secret references and platform backup to the set. Hash and
   upload all artifacts; verify every object is readable from the recovery host, then record
   a complete-set receipt outside the affected host. A local success or upload attempt alone
   is insufficient. Release the fence only after completeness and service readiness are checked.
7. Send a success heartbeat **after** off-host verification, and alert on failure, missed schedule
   and overdue restore drill. Do not report a complete set when one store or credential is missing.

## Isolated restore drill

Run before launch, monthly thereafter and after changes to engines, schema, access provisioning
or backup tooling. Start the RTO clock at incident declaration, including destination provisioning,
downloads, decryption and validation. Never rehearse by importing into production.

1. Identify one complete set. Verify checksums, engine versions, decrypt permissions and all
   required secret references. Prepare **empty isolated** Postgres, ClickHouse and queue targets,
   isolated DNS/origin and a mail sink. No live production writer or worker may reach them.
2. Restore only the intended roles/grants, then the custom dump with
   `pg_restore --exit-on-error --no-owner --dbname=<isolated-database> <postgres.dump>` using
   private connection settings. Reconcile ownership/grants explicitly with the provisioned
   application role; `--no-owner` alone does not do that. Do not import other tenants' globals
   or use `--clean` against populated/shared databases. Record database counts and migrations.
3. Restore ClickHouse into the isolated empty `logbird` database from the recorded backup disk.
   Keep database name and materialized-view destinations consistent. Restore/reprovision access
   policies using the **preserved** query password and that release's provisioning command.
   Verify raw/derived table counts, samples and row-policy isolation before allowing app reads.
4. Restore the queue persistence with its version-matched engine and original `{logbird}` prefix.
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
   known event IDs/payloads/counts, Query/SQL restrictions and raw/rollup agreement. Confirm no
   event acknowledged before the recorded backup fence is absent from that boundary. Start the
   worker and prove scheduler registration, lease recovery and one completed retention fixture.
7. Record actual recovered boundary/RPO, elapsed RTO, artifact IDs, checks, omissions and operator.
   Capture unexpected reappearing users/projects/deleted data: restoring an older set can resurrect
   removals. Reapply the verified deletion inventory **before** production traffic; if that
   inventory is unavailable, keep access fenced and escalate. Expired retention data must not
   become customer-visible merely because a backup contains it.
8. Stop all drill processes, revoke only drill-specific credentials where authorized, and remove
   only verified drill-owned resources after the evidence is retained. Do not rotate/delete
   existing production keys. Keep the source recovery artifacts unchanged.

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
