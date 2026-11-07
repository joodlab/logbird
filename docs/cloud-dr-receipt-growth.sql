-- Both variants: load independently recorded expected_receipt_multiplicity.
-- For C use the recorded physical ceiling from a fully accepted B, not fresh C data.
SELECT throwIf(count() = 0, 'no receipt multiplicity baseline'),
       throwIf(count() != uniqExact((project_id,event_id,received_at,timestamp)), 'duplicate multiplicity baseline tuples'),
       throwIf(count() != {manifest_multiplicity_count:UInt64}, 'multiplicity baseline count mismatch'),
       throwIf(countIf(physical_rows = 0) != 0, 'invalid zero multiplicity ceiling')
FROM expected_receipt_multiplicity WHERE project_id = {fixture_project:String} FORMAT Null;

-- Empty result = no unexplained physical growth. Background replacing merges may decrease counts.
WITH
    ceiling AS (
        SELECT project_id,event_id,received_at,timestamp,physical_rows AS allowed_rows
        FROM expected_receipt_multiplicity WHERE project_id = {fixture_project:String}
    ),
    actual AS (
        SELECT project_id,event_id,received_at,timestamp,count() AS physical_rows
        FROM logbird.event_ids WHERE project_id = {fixture_project:String}
        GROUP BY project_id,event_id,received_at,timestamp
    )
SELECT a.project_id,a.event_id,a.received_at,a.timestamp,a.physical_rows,c.allowed_rows
FROM actual AS a LEFT JOIN ceiling AS c USING (project_id,event_id,received_at,timestamp)
WHERE a.physical_rows > coalesce(c.allowed_rows,0);
