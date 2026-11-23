BEGIN;

-- A nullable header ID preserves the exact signed identifier of deliveries already queued.
ALTER TABLE "WebhookDelivery" ADD COLUMN "webhookId" TEXT;
CREATE UNIQUE INDEX "WebhookDelivery_endpointId_eventId_receivedAt_key"
    ON "WebhookDelivery"("endpointId", "eventId", "receivedAt");
DROP INDEX "WebhookDelivery_endpointId_eventId_key";

COMMIT;
