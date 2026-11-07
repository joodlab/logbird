-- Run only if migration 006/event_ids and its MV are present in the release inventory.
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

-- Physical duplicate receipts from a repeated MV population must also fail.
SELECT project_id, event_id, count() AS receipts
FROM logbird.event_ids WHERE project_id = {fixture_project:String}
GROUP BY project_id, event_id HAVING receipts != 1;
