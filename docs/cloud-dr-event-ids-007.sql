-- 007 only: inventory records 007 complete and actual event_ids engine is plain MergeTree.
-- All result sets must be empty. No FINAL is valid on this engine.
SELECT throwIf(countIf(name = '006_event_ids.sql') != 1 OR countIf(name = '007_event_ids_merge_tree.sql') != 1, '007 receipt migration inventory mismatch')
FROM logbird.migrations FORMAT Null;
SELECT throwIf(countIf(name = 'event_ids') != 1 OR anyIf(engine,name = 'event_ids') != 'MergeTree'
               OR countIf(name != 'event_ids') != 0, '007 receipt engine or interrupted migration mismatch')
FROM system.tables WHERE database = 'logbird' AND name IN ('event_ids','event_ids_v2','event_ids_v2_mv') FORMAT Null;

SELECT throwIf(count() = 0, 'no fixture receipt tuples'),
       throwIf(count() != uniqExact((project_id,event_id,received_at,timestamp)), 'duplicate expected receipt tuples'),
       throwIf(count() != {manifest_receipt_count:UInt64}, 'expected receipt tuple count mismatch'),
       throwIf(uniqExact((project_id,event_id)) != {manifest_receipt_id_count:UInt64}, 'expected receipt ID count mismatch')
FROM expected_receipts WHERE project_id = {fixture_project:String} FORMAT Null;
SELECT throwIf(uniqExact((project_id,event_id,received_at,timestamp)) != {manifest_receipt_count:UInt64}, 'actual receipt tuple count mismatch'),
       throwIf(uniqExact((project_id,event_id)) != {manifest_receipt_id_count:UInt64}, 'actual receipt ID count mismatch')
FROM logbird.event_ids WHERE project_id = {fixture_project:String} FORMAT Null;

-- Distinct ID set, independently of physical overlap from the online backfill.
WITH
    expected AS (SELECT DISTINCT project_id,event_id FROM expected_receipts WHERE project_id = {fixture_project:String}),
    actual AS (SELECT DISTINCT project_id,event_id FROM logbird.event_ids WHERE project_id = {fixture_project:String})
SELECT * FROM (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
UNION ALL
SELECT * FROM (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected);

-- Complete distinct receipt tuples must survive, including noncanonical legacy versions.
WITH
    expected AS (SELECT project_id,event_id,received_at,timestamp FROM expected_receipts WHERE project_id = {fixture_project:String}),
    actual AS (SELECT DISTINCT project_id,event_id,received_at,timestamp FROM logbird.event_ids WHERE project_id = {fixture_project:String})
SELECT * FROM (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
UNION ALL
SELECT * FROM (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected);

-- Mirror existingEventIdentities: oldest surviving received_at, then timestamp, then ID.
WITH
    expected AS (
        SELECT project_id,event_id,received_at,timestamp FROM expected_receipts
        WHERE project_id = {fixture_project:String}
        ORDER BY received_at,timestamp,event_id LIMIT 1 BY event_id
    ),
    actual AS (
        SELECT project_id,event_id,received_at,timestamp FROM logbird.event_ids
        WHERE project_id = {fixture_project:String}
        ORDER BY received_at,timestamp,event_id LIMIT 1 BY event_id
    )
SELECT * FROM (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
UNION ALL
SELECT * FROM (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected);

-- Physical multiplicity is NOT required to be one; use cloud-dr-receipt-growth.sql.
