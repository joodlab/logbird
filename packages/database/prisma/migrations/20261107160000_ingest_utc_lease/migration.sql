-- Preserve receipt/event clocks and existing migration checksums; reset only unresolved live leases conservatively.
ALTER TABLE "IngestReceipt" ALTER COLUMN "claimedAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
UPDATE "IngestReceipt" SET "claimedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "confirmedAt" IS NULL AND "claimedAt" IS NOT NULL;
