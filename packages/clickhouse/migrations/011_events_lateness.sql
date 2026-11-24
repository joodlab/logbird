-- Late arrivals for the webhook delivery window (#152): events per project, arrival hour and lateness in whole hours.
-- late_hours = ceil((received_at - timestamp) / 1 hour), floored at 0 (an occurrence time ahead of arrival is not late)
-- and capped at 87601, one past the largest window (3,650 days = 87,600 hours). A window of k hours counts exactly the
-- rows with late_hours > k. Counting starts when the view is created (no backfill). Rows live 32 days, a little past the
-- 30 days the count looks back, so retention never has to delete them. Project deletion deletes them (purgeProject).
-- Only the internal user reads this table: logbird_query has no grant on it.
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
TTL received_hour + INTERVAL 32 DAY DELETE;

CREATE MATERIALIZED VIEW IF NOT EXISTS events_lateness_mv TO events_lateness_by_hour AS
SELECT
  project_id,
  toStartOfHour(received_at) AS received_hour,
  toUInt32(least(87601, greatest(0, intDiv(toUnixTimestamp64Milli(received_at) - toUnixTimestamp64Milli(timestamp) + 3599999, 3600000)))) AS late_hours,
  count() AS events
FROM events
GROUP BY project_id, received_hour, late_hours
