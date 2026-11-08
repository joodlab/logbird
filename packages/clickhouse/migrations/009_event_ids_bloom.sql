-- Primary-key pruning still applies first. The skip index avoids decoding absent ids in each active part.
ALTER TABLE event_ids ADD INDEX IF NOT EXISTS idx_event_ids_bloom event_id TYPE bloom_filter(0.0001) GRANULARITY 256;
-- Existing parts remain readable throughout. Repeating materialization rewrites index files only, never rows.
ALTER TABLE event_ids MATERIALIZE INDEX idx_event_ids_bloom SETTINGS mutations_sync=2;
