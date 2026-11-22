-- Arrival-time reads (webhook discovery, alerts, live view) filter project_id and a received_at slice. events is
-- ordered by (project_id, timestamp, event_id) and partitioned by timestamp month, so without this index such a read
-- scans every granule of the project that partition and primary-key pruning keep, whatever their arrival time (how that
-- grows with retained history was not measured). A
-- minmax skip index per granule lets ClickHouse skip granules whose arrival range misses the slice. Event values are unchanged, but MATERIALIZE writes index files
-- for every part and rewrites compact parts. It runs as a background mutation: reads stay correct meanwhile and use
-- the index on parts as they finish, and new parts get it on insert.
-- The migration runner splits statements on semicolons, so comments here must not contain one.
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_received_at received_at TYPE minmax GRANULARITY 1;
ALTER TABLE events MATERIALIZE INDEX idx_received_at SETTINGS mutations_sync = 0;
