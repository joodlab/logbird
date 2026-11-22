-- Existing endpoints start at rollout with no historical backfill.
BEGIN;
ALTER TABLE "WebhookEndpoint"
    ADD COLUMN "cursorReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "cursorEventId" TEXT,
    ADD COLUMN "lastScannedAt" TIMESTAMP(3),
    ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "failingSince" TIMESTAMP(3);
CREATE INDEX "WebhookEndpoint_enabled_lastScannedAt_id_idx" ON "WebhookEndpoint"("enabled", "lastScannedAt", "id");

CREATE TABLE "WebhookDelivery" (
    "id" TEXT PRIMARY KEY,
    "endpointId" TEXT NOT NULL REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "eventId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "attemptNumber" INTEGER NOT NULL DEFAULT 0,
    "windowAttempts" INTEGER NOT NULL DEFAULT 0,
    "retryUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "WebhookDelivery_endpointId_eventId_key" ON "WebhookDelivery"("endpointId", "eventId");
CREATE INDEX "WebhookDelivery_endpointId_id_idx" ON "WebhookDelivery"("endpointId", "id");
CREATE INDEX "WebhookDelivery_endpointId_status_nextAttemptAt_id_idx" ON "WebhookDelivery"("endpointId", "status", "nextAttemptAt", "id");
CREATE INDEX "WebhookDelivery_expiresAt_idx" ON "WebhookDelivery"("expiresAt");

CREATE TABLE "WebhookAttempt" (
    "deliveryId" TEXT NOT NULL REFERENCES "WebhookDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "number" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "error" TEXT,
    PRIMARY KEY ("deliveryId", "number")
);
CREATE INDEX "WebhookAttempt_startedAt_idx" ON "WebhookAttempt"("startedAt");

CREATE TABLE "WebhookDisableNotice" (
    "id" TEXT PRIMARY KEY,
    "endpointId" TEXT NOT NULL REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "recipientId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "WebhookDisableNotice_endpointId_idx" ON "WebhookDisableNotice"("endpointId");
CREATE INDEX "WebhookDisableNotice_nextAttemptAt_idx" ON "WebhookDisableNotice"("nextAttemptAt");
CREATE INDEX "WebhookDisableNotice_createdAt_idx" ON "WebhookDisableNotice"("createdAt");
COMMIT;
