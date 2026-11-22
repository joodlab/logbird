BEGIN;

ALTER TABLE "WebhookEndpoint"
    ALTER COLUMN "cursorReceivedAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    ADD COLUMN "secretOverlapWarnedAt" TIMESTAMP(3);
ALTER TABLE "WebhookDelivery"
    ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    ALTER COLUMN "nextAttemptAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
ALTER TABLE "WebhookDisableNotice"
    ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    ALTER COLUMN "nextAttemptAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');

-- Repair only untouched rollout cursors. Prisma records the original rollout instant with a zone.
-- Reuse that fixed instant so a delayed correction cannot skip arrivals since rollout.
-- Endpoints created with the delivery schema start at their creation clock and need no rollout repair.
UPDATE "WebhookEndpoint" e
SET "cursorReceivedAt" = (m.started_at AT TIME ZONE 'UTC')::TIMESTAMP(3)
FROM "_prisma_migrations" m
WHERE m.migration_name = '20261122140000_webhook_deliveries'
  AND m.finished_at IS NOT NULL AND m.rolled_back_at IS NULL
  AND e."createdAt" <> e."cursorReceivedAt"
  AND e."createdAt" <= greatest(e."cursorReceivedAt", (m.started_at AT TIME ZONE 'UTC')::TIMESTAMP(3))
  AND e."lastScannedAt" IS NULL AND e."cursorEventId" IS NULL
  AND e."cursorReceivedAt" <> (m.started_at AT TIME ZONE 'UTC')::TIMESTAMP(3)
  AND NOT EXISTS (SELECT 1 FROM "WebhookDelivery" d WHERE d."endpointId" = e.id);

COMMIT;
