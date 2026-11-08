CREATE TABLE IF NOT EXISTS event_ids
(
  project_id LowCardinality(String),
  event_id String,
  received_at DateTime64(3, 'UTC'),
  timestamp DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(received_at)
ORDER BY (project_id, event_id)
TTL toDateTime(least(received_at + INTERVAL 3650 DAY, toDateTime64('2106-02-07 06:28:15', 3, 'UTC'))) DELETE;

ALTER TABLE event_ids MODIFY TTL toDateTime(least(received_at + INTERVAL 3650 DAY, toDateTime64('2106-02-07 06:28:15', 3, 'UTC'))) DELETE SETTINGS materialize_ttl_after_modify=0;

CREATE MATERIALIZED VIEW IF NOT EXISTS event_ids_mv TO event_ids AS
SELECT project_id, event_id, received_at, timestamp FROM events;

INSERT INTO event_ids SELECT project_id, event_id, received_at, timestamp FROM events;
