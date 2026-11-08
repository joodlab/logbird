-- Bounded recent-id cache plus durable unresolved writes. No event payloads, no ClickHouse rebuild.
CREATE TABLE "IngestReceipt" (
  "projectId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "fingerprint" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "eventAt" TIMESTAMP(3) NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  PRIMARY KEY ("projectId", "eventId")
);
CREATE INDEX "IngestReceipt_projectId_confirmedAt_idx" ON "IngestReceipt"("projectId", "confirmedAt");
CREATE INDEX "IngestReceipt_confirmedAt_idx" ON "IngestReceipt"("confirmedAt");
CREATE INDEX "IngestReceipt_projectId_eventAt_idx" ON "IngestReceipt"("projectId", "eventAt");
CREATE INDEX "IngestReceipt_organizationId_idx" ON "IngestReceipt"("organizationId");
