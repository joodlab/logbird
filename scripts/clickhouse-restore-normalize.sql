-- OFFLINE OPERATOR STEP: preserve the backup, stop ALL writers, inspect the dry run.
-- Requires disk for another full raw table. Never run against a live instance.
-- An existing staging table deliberately stops this script: inspect/recover it first.
SELECT throwIf(count()!=0,'Wait for existing mutations to finish before normalization') FROM system.mutations WHERE database='logbird' AND NOT is_done;
CREATE TABLE logbird.events_restore_staging AS logbird.events ENGINE=MergeTree ORDER BY tuple();
INSERT INTO logbird.events_restore_staging SELECT * FROM logbird.events;
SELECT throwIf(count()!=0,'Staging differs from raw events; keep the snapshot and investigate') FROM (SELECT * FROM logbird.events EXCEPT ALL SELECT * FROM logbird.events_restore_staging);
SELECT throwIf(count()!=0,'Staging differs from raw events; keep the snapshot and investigate') FROM (SELECT * FROM logbird.events_restore_staging EXCEPT ALL SELECT * FROM logbird.events);
-- Migration 011 (checked before anything is cleared: a missing rollup or a leftover snapshot stops here): the webhook lateness rollup counts arrivals, including some whose raw rows have since expired, so it is
-- kept as restored, not rebuilt. Snapshot its totals, then keep its view out of the replay. DETACH without PERMANENTLY
-- lasts until the next server restart, and ClickHouse migrations re-attach it, so a run that stops below cannot leave the
-- view missing.
CREATE TABLE logbird.lateness_restore_check ENGINE=MergeTree ORDER BY tuple() AS SELECT project_id, received_hour, late_hours, sum(events) AS events FROM logbird.events_lateness_by_hour GROUP BY project_id, received_hour, late_hours;
DETACH TABLE IF EXISTS logbird.events_lateness_mv;
TRUNCATE TABLE logbird.events;
TRUNCATE TABLE logbird.events_by_minute;
TRUNCATE TABLE logbird.entities;
TRUNCATE TABLE logbird.attribute_keys;
-- Migration 006 / PR #62 adds this MV destination. Clear it before replaying raw rows.
TRUNCATE TABLE IF EXISTS logbird.event_ids;
-- SELECT * includes received_at, payload and both change kind arrays when present, and omits the recomputed MATERIALIZED category.
-- Existing materialized views rebuild every destination exactly once.
INSERT INTO logbird.events SELECT * FROM logbird.events_restore_staging;
SELECT throwIf(count()!=0,'Restored events differ from staging; keep staging and do not resume writers') FROM (SELECT * FROM logbird.events EXCEPT ALL SELECT * FROM logbird.events_restore_staging);
SELECT throwIf(count()!=0,'Restored events differ from staging; keep staging and do not resume writers') FROM (SELECT * FROM logbird.events_restore_staging EXCEPT ALL SELECT * FROM logbird.events);
SELECT throwIf((SELECT count() FROM logbird.events)!=(SELECT sum(events) FROM logbird.events_by_minute),'Minute rollup mismatch');
SELECT throwIf((SELECT sum((actor_id!='')+(tenant_id!='')+(executor_id!='')+length(target_ids)) FROM logbird.events)!=(SELECT sum(events) FROM logbird.entities),'Entity rollup mismatch');
SELECT throwIf((SELECT sum(length(mapKeys(attributes))) FROM logbird.events)!=(SELECT sum(count) FROM logbird.attribute_keys),'Attribute rollup mismatch');
ATTACH TABLE IF NOT EXISTS logbird.events_lateness_mv;
-- TTL may drop parts whose rows expired (32 days after their arrival hour) while this script runs; that is expected, so
-- each comparison covers only rows unexpired at its own now(). TTL cannot have dropped those, so any difference is real.
SELECT throwIf(count()!=0,'Lateness rollup changed during replay; keep staging and investigate') FROM (SELECT project_id, received_hour, late_hours, sum(events) AS events FROM logbird.events_lateness_by_hour WHERE received_hour > now() - INTERVAL 32 DAY GROUP BY project_id, received_hour, late_hours EXCEPT ALL SELECT * FROM logbird.lateness_restore_check WHERE received_hour > now() - INTERVAL 32 DAY);
SELECT throwIf(count()!=0,'Lateness rollup changed during replay; keep staging and investigate') FROM (SELECT * FROM logbird.lateness_restore_check WHERE received_hour > now() - INTERVAL 32 DAY EXCEPT ALL SELECT project_id, received_hour, late_hours, sum(events) AS events FROM logbird.events_lateness_by_hour WHERE received_hour > now() - INTERVAL 32 DAY GROUP BY project_id, received_hour, late_hours);
DROP TABLE logbird.lateness_restore_check;
-- Keep staging until the operator verifies event_ids (when present), retention and receipts.
