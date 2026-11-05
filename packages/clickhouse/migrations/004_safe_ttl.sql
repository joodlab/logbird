ALTER TABLE events MODIFY TTL toDateTime(received_at + INTERVAL 3650 DAY) DELETE SETTINGS materialize_ttl_after_modify=0;
