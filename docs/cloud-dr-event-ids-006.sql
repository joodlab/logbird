-- 006 only: inventory has 006 but not 007, actual engine ReplacingMergeTree.
SELECT throwIf(countIf(name = '006_event_ids.sql') != 1 OR countIf(name = '007_event_ids_merge_tree.sql') != 0, '006 receipt migration inventory mismatch')
FROM logbird.migrations FORMAT Null;
SELECT throwIf(countIf(name = 'event_ids') != 1 OR anyIf(engine,name = 'event_ids') != 'ReplacingMergeTree'
               OR countIf(name != 'event_ids') != 0, '006 receipt engine or interrupted migration mismatch')
FROM system.tables WHERE database = 'logbird' AND name IN ('event_ids','event_ids_v2','event_ids_v2_mv','event_ids_v3','event_ids_v3_mv') FORMAT Null;
-- This release's retention also purges expired receipts: load checkpoint A's
-- original IDs, then the independently filtered survivor IDs for B and C.
-- Load expected_receipts as documented; both result sets must be empty.
SELECT throwIf(count() = 0, 'no fixture receipts'),
       throwIf(count() != {manifest_receipt_count:UInt64}, 'expected receipt manifest count mismatch')
FROM expected_receipts WHERE project_id = {fixture_project:String} FORMAT Null;
SELECT throwIf(count() != {manifest_receipt_count:UInt64}, 'actual receipt manifest count mismatch')
FROM logbird.event_ids FINAL WHERE project_id = {fixture_project:String} FORMAT Null;

WITH
    expected AS (SELECT * FROM expected_receipts WHERE project_id = {fixture_project:String}),
    actual AS (
        SELECT project_id, event_id, received_at, timestamp
        FROM logbird.event_ids FINAL WHERE project_id = {fixture_project:String}
    )
SELECT * FROM (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
UNION ALL
SELECT * FROM (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected);

-- Record physical multiplicity separately and execute cloud-dr-receipt-growth.sql.
