-- Read-only dry run. Stop server/worker/ingesters before executing normalization.
SELECT version();
SELECT table,name,rows,data_version FROM system.parts WHERE active AND database='logbird' ORDER BY table,name;
SELECT table,mutation_id,is_done,latest_fail_reason FROM system.mutations WHERE database='logbird' ORDER BY table,mutation_id;
SELECT name,engine FROM system.tables WHERE database='logbird' AND (name IN ('events','events_by_minute','entities','attribute_keys','event_ids','event_ids_mv','events_restore_staging') OR engine='MaterializedView') ORDER BY name;
SELECT count() raw_rows,sum(cityHash64(payload)) payload_checksum,sum(cityHash64(toString(received_at))) received_at_checksum FROM logbird.events;
