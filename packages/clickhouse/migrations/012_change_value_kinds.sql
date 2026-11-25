-- Empty arrays for older rows and older writers. No mutation or backfill.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS changes_before_kind Array(Enum8('absent' = 1, 'null' = 2, 'string' = 3, 'number' = 4, 'boolean' = 5, 'json' = 6)) AFTER changes_after,
  ADD COLUMN IF NOT EXISTS changes_after_kind Array(Enum8('absent' = 1, 'null' = 2, 'string' = 3, 'number' = 4, 'boolean' = 5, 'json' = 6)) AFTER changes_before_kind;
