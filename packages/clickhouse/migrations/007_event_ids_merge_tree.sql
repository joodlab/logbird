-- The runner guards phases by durable engine so an interrupted EXCHANGE cannot be replayed backwards.
CREATE TABLE IF NOT EXISTS event_ids_v2
(
  project_id LowCardinality(String),
  event_id String,
  received_at DateTime64(3, 'UTC'),
  timestamp DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (project_id, event_id, received_at, timestamp)
TTL toDateTime(least(received_at + INTERVAL 3650 DAY, toDateTime64('2106-02-07 06:28:15', 3, 'UTC'))) DELETE;
CREATE MATERIALIZED VIEW IF NOT EXISTS event_ids_v2_mv TO event_ids_v2 AS
SELECT project_id, event_id, received_at, timestamp FROM events;
INSERT INTO event_ids_v2 SELECT project_id, event_id, received_at, timestamp FROM events;
EXCHANGE TABLES event_ids AND event_ids_v2;
DROP VIEW IF EXISTS event_ids_v2_mv SYNC;
DROP TABLE IF EXISTS event_ids_v2 SYNC;

-- A long-running INSERT SELECT can capture only the original MV before the second MV attaches.
-- Its rows can finish after the backfill snapshot or during retirement. Attaching an MV is not retroactive.
-- The retired-table SYNC precedes this idempotent missing-tuple coverage pass for those late writers.
INSERT INTO event_ids
SELECT DISTINCT project_id,event_id,received_at,timestamp FROM events
WHERE (project_id,event_id,received_at,timestamp) NOT IN
(SELECT project_id,event_id,received_at,timestamp FROM event_ids);
