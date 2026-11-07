-- Read-only checks after loading checkpoint-specific expected_events in THIS client session.
-- Each result set must be empty. Use a small isolated QA fixture, not customer data.
-- Parameters: fixture_project (String). No FINAL: duplicate physical raw rows must fail.

-- 1. Raw bytes and multiplicity: includes received_at, payload and all exported columns.
WITH
    expected AS (SELECT * FROM expected_events WHERE project_id = {fixture_project:String}),
    actual AS (SELECT * FROM logbird.events WHERE project_id = {fixture_project:String})
SELECT * FROM (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
UNION ALL
SELECT * FROM (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected);

-- 2. Minute values by the complete SummingMergeTree key.
WITH
    expected AS (
        SELECT project_id, toStartOfMinute(timestamp) AS bucket, environment,
               action, outcome, actor_type, executor_type, count() AS events
        FROM expected_events WHERE project_id = {fixture_project:String}
        GROUP BY project_id, bucket, environment, action, outcome, actor_type, executor_type
    ),
    actual AS (
        SELECT project_id, bucket, environment, action, outcome, actor_type, executor_type,
               sum(events) AS events
        FROM logbird.events_by_minute WHERE project_id = {fixture_project:String}
        GROUP BY project_id, bucket, environment, action, outcome, actor_type, executor_type
    )
SELECT * FROM (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
UNION ALL
SELECT * FROM (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected);

-- 3. Entity values. Fixture labels must be constant for each (kind, entity_id).
WITH
    expanded AS (
        SELECT project_id, 'actor' AS kind, actor_id AS entity_id,
               actor_type AS type, actor_name AS name, timestamp
        FROM expected_events WHERE project_id = {fixture_project:String} AND actor_id != ''
        UNION ALL
        SELECT project_id, 'tenant', tenant_id, '', tenant_name, timestamp
        FROM expected_events WHERE project_id = {fixture_project:String} AND tenant_id != ''
        UNION ALL
        SELECT project_id, 'executor', executor_id, executor_type, executor_name, timestamp
        FROM expected_events WHERE project_id = {fixture_project:String} AND executor_id != ''
        UNION ALL
        SELECT project_id, 'target', concat(t.1, ':', t.2), t.1, t.3, timestamp
        FROM expected_events ARRAY JOIN arrayZip(target_types, target_ids, target_names) AS t
        WHERE project_id = {fixture_project:String} AND concat(t.1, ':', t.2) != ''
    ),
    expected AS (
        SELECT project_id, kind, entity_id, anyLast(type) AS type, anyLast(name) AS name,
               min(timestamp) AS first_seen, max(timestamp) AS last_seen, count() AS events
        FROM expanded GROUP BY project_id, kind, entity_id
    ),
    actual AS (
        SELECT project_id, kind, entity_id, anyLast(type) AS type, anyLast(name) AS name,
               min(first_seen) AS first_seen, max(last_seen) AS last_seen, sum(events) AS events
        FROM logbird.entities WHERE project_id = {fixture_project:String}
        GROUP BY project_id, kind, entity_id
    )
SELECT * FROM (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
UNION ALL
SELECT * FROM (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected);

-- 4. Attributes. Use <=5 distinct values per fixture key to make samples exact.
-- SimpleAggregateFunction(sum, ...) uses sum; only samples is an AggregateFunction state.
WITH
    expected AS (
        SELECT project_id, k AS key, count() AS count, max(timestamp) AS last_seen,
               arraySort(groupUniqArray(5)(attributes[k])) AS samples
        FROM expected_events ARRAY JOIN mapKeys(attributes) AS k
        WHERE project_id = {fixture_project:String} GROUP BY project_id, k
    ),
    actual AS (
        SELECT project_id, key, sum(count) AS count, max(last_seen) AS last_seen,
               arraySort(groupUniqArrayMerge(5)(samples)) AS samples
        FROM logbird.attribute_keys WHERE project_id = {fixture_project:String}
        GROUP BY project_id, key
    )
SELECT * FROM (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
UNION ALL
SELECT * FROM (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected);
