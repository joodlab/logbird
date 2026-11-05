ALTER TABLE events MODIFY TTL toDateTime(least(received_at + INTERVAL 3650 DAY, toDateTime64('2106-02-07 06:28:15', 3, 'UTC'))) DELETE SETTINGS materialize_ttl_after_modify=0;
