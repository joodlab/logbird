BEGIN;

ALTER TABLE "WebhookEndpoint"
  ADD COLUMN "filterReviewRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "filterReviewNoticeClaimedAt" TIMESTAMP(3);

-- Confirm stored filters under the new query language before scanning any further.
UPDATE "WebhookEndpoint" SET "filterReviewRequired" = true WHERE "filterQuery" <> '';

COMMIT;
