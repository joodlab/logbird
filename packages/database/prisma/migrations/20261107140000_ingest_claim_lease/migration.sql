ALTER TABLE "IngestReceipt" ADD COLUMN "claimedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "IngestReceipt_projectId_confirmedAt_claimedAt_idx" ON "IngestReceipt"("projectId", "confirmedAt", "claimedAt");
