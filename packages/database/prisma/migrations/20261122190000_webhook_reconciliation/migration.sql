ALTER TABLE "WebhookEndpoint"
  ADD COLUMN "scopeReviewRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cursorVerifiedFloor" TIMESTAMP(3);
