-- Late arrivals for the webhook delivery window (#152): events per project, arrival hour and lateness in whole hours.
-- late_hours = ceil((received_at - timestamp) / 1 hour), capped at 87601, one past the largest window (3,650 days =
-- 87,600 hours). A window of k hours counts exactly the rows with late_hours > k.
-- Only events more than one hour late reach the table. The smallest window is one hour, so an event at most one hour late
-- (late_hours 0 or 1, on-time traffic included) can never be counted by any window, and an on-time insert block adds no
-- rows and writes no part here. That keeps the view's cost on ordinary ingest to one predicate per row.
-- Counting starts when the view is created (no backfill). Rows expire 32 days after their arrival hour, a little past the
-- 30 days the count looks back, so retention never has to delete them. The TTL drops whole monthly parts, so expired rows
-- can linger until their part expires, which reads bounded by `since` never see. Project deletion deletes them
-- (purgeProject). Only the internal user reads this table: logbird_query has no grant on it.
CREATE TABLE IF NOT EXISTS events_lateness_by_hour
(
  project_id LowCardinality(String),
  received_hour DateTime('UTC'),
  late_hours UInt32,
  events UInt64
)
ENGINE = SummingMergeTree(events)
PARTITION BY toYYYYMM(received_hour)
ORDER BY (project_id, received_hour, late_hours)
TTL toDateTime(least(toDateTime64(received_hour, 3, 'UTC') + INTERVAL 32 DAY, toDateTime64('2106-02-07 06:28:15', 3, 'UTC'))) DELETE
SETTINGS ttl_only_drop_parts = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS events_lateness_mv TO events_lateness_by_hour AS
SELECT
  project_id,
  toStartOfHour(received_at) AS received_hour,
  toUInt32(least(87601, intDiv(toUnixTimestamp64Milli(received_at) - toUnixTimestamp64Milli(timestamp) + 3599999, 3600000))) AS late_hours,
  count() AS events
FROM events
WHERE toUnixTimestamp64Milli(received_at) - toUnixTimestamp64Milli(timestamp) > 3600000
GROUP BY project_id, received_hour, late_hours
