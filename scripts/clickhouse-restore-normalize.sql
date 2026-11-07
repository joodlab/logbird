-- OFFLINE OPERATOR STEP: preserve the backup, stop ALL writers, inspect the dry run.
-- Requires disk for another full raw table. Never run against a live instance.
-- An existing staging table deliberately stops this script: inspect/recover it first.
SELECT throwIf(count()!=0,'Wait for existing mutations to finish before normalization') FROM system.mutations WHERE database='logbird' AND NOT is_done;
CREATE TABLE logbird.events_restore_staging AS logbird.events ENGINE=MergeTree ORDER BY tuple();
INSERT INTO logbird.events_restore_staging SELECT * FROM logbird.events;
SELECT throwIf(count()!=0,'Staging differs from raw events; keep the snapshot and investigate') FROM (SELECT * FROM logbird.events EXCEPT ALL SELECT * FROM logbird.events_restore_staging);
SELECT throwIf(count()!=0,'Staging differs from raw events; keep the snapshot and investigate') FROM (SELECT * FROM logbird.events_restore_staging EXCEPT ALL SELECT * FROM logbird.events);
TRUNCATE TABLE logbird.events;
TRUNCATE TABLE logbird.events_by_minute;
TRUNCATE TABLE logbird.entities;
TRUNCATE TABLE logbird.attribute_keys;
-- Migration 006 / PR #62 adds this MV destination. Clear it before replaying raw rows.
TRUNCATE TABLE IF EXISTS logbird.event_ids;
-- SELECT * includes received_at and payload, and omits the recomputed MATERIALIZED category.
-- Existing materialized views rebuild every destination exactly once.
INSERT INTO logbird.events SELECT * FROM logbird.events_restore_staging;
SELECT throwIf(count()!=0,'Restored events differ from staging; keep staging and do not resume writers') FROM (SELECT * FROM logbird.events EXCEPT ALL SELECT * FROM logbird.events_restore_staging);
SELECT throwIf(count()!=0,'Restored events differ from staging; keep staging and do not resume writers') FROM (SELECT * FROM logbird.events_restore_staging EXCEPT ALL SELECT * FROM logbird.events);
SELECT throwIf((SELECT count() FROM logbird.events)!=(SELECT sum(events) FROM logbird.events_by_minute),'Minute rollup mismatch');
SELECT throwIf((SELECT sum((actor_id!='')+(tenant_id!='')+(executor_id!='')+length(target_ids)) FROM logbird.events)!=(SELECT sum(events) FROM logbird.entities),'Entity rollup mismatch');
SELECT throwIf((SELECT sum(length(mapKeys(attributes))) FROM logbird.events)!=(SELECT sum(count) FROM logbird.attribute_keys),'Attribute rollup mismatch');
-- Keep staging until the operator verifies event_ids (when present), retention and receipts.
