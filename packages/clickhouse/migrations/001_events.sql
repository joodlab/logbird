CREATE TABLE IF NOT EXISTS events
(
  project_id        LowCardinality(String),
  event_id          String,
  timestamp         DateTime64(3, 'UTC'),
  received_at       DateTime64(3, 'UTC') DEFAULT now64(3),
  environment       LowCardinality(String) DEFAULT 'production',
  action            LowCardinality(String),
  category          LowCardinality(String) MATERIALIZED splitByChar('.', action)[1],
  outcome           LowCardinality(String) DEFAULT 'success',
  severity          LowCardinality(String) DEFAULT 'info',
  description       String,
  actor_type        LowCardinality(String),
  actor_id          String,
  actor_name        String,
  actor_email       String,
  impersonator_id   String,
  impersonator_name String,
  executor_type     LowCardinality(String),
  executor_id       String,
  executor_name     String,
  job_id            String,
  job_attempt       UInt16,
  tenant_id         String,
  tenant_name       String,
  source            LowCardinality(String),
  target_types      Array(LowCardinality(String)),
  target_ids        Array(String),
  target_names      Array(String),
  changes_fields    Array(String),
  changes_before    Array(String),
  changes_after     Array(String),
  operation_id      String,
  parent_event_id   String,
  request_id        String,
  trace_id          String,
  ip                String,
  user_agent        String,
  attributes        Map(LowCardinality(String), String),
  payload           String CODEC(ZSTD(3)),
  conformance       UInt8,
  schema_version    LowCardinality(String),
  sdk               LowCardinality(String),

  INDEX idx_event_id   event_id        TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_actor      actor_id        TYPE bloom_filter(0.01)  GRANULARITY 1,
  INDEX idx_tenant     tenant_id       TYPE bloom_filter(0.01)  GRANULARITY 1,
  INDEX idx_executor   executor_id     TYPE bloom_filter(0.01)  GRANULARITY 1,
  INDEX idx_targets    target_ids      TYPE bloom_filter(0.01)  GRANULARITY 1,
  INDEX idx_operation  operation_id    TYPE bloom_filter(0.01)  GRANULARITY 1,
  INDEX idx_parent     parent_event_id TYPE bloom_filter(0.01)  GRANULARITY 1,
  INDEX idx_request    request_id      TYPE bloom_filter(0.01)  GRANULARITY 1,
  INDEX idx_attr_keys  mapKeys(attributes)   TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_attr_vals  mapValues(attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_text       lower(concat(description, ' ', actor_name, ' ', tenant_name, ' ', arrayStringConcat(target_names, ' ')))
                       TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(received_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_id, timestamp, event_id)
TTL toDateTime(timestamp) + INTERVAL 3650 DAY DELETE   -- hard cap, per-project retention is enforced by the worker
SETTINGS index_granularity = 8192;

