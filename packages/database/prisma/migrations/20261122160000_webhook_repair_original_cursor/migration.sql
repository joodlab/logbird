BEGIN;

-- PostgreSQL retains the value used by the original fast ADD COLUMN default, even after SET DEFAULT.
-- Compare with that exact timestamp instead of treating a scan timestamp or test ping as progress.
WITH rollout AS (
    SELECT (started_at AT TIME ZONE 'UTC')::TIMESTAMP(3) AS utc_start,
           (a.attmissingval::TEXT::TIMESTAMP(3)[])[1] AS original_cursor
    FROM "_prisma_migrations"
    CROSS JOIN pg_attribute a
    WHERE migration_name = '20261122140000_webhook_deliveries'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      AND a.attrelid = '"WebhookEndpoint"'::regclass AND a.attname = 'cursorReceivedAt' AND a.atthasmissing
)
UPDATE "WebhookEndpoint" e
SET "cursorReceivedAt" = rollout.utc_start
FROM rollout
WHERE e."cursorReceivedAt" = rollout.original_cursor
  AND e."cursorReceivedAt" <> rollout.utc_start
  AND e."createdAt" <> e."cursorReceivedAt"
  AND e."createdAt" <= greatest(rollout.utc_start, rollout.original_cursor)
  AND e."cursorEventId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "WebhookDelivery" d WHERE d."endpointId" = e.id AND d."receivedAt" IS NOT NULL);

COMMIT;
