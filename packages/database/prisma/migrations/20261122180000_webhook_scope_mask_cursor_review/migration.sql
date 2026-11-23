ALTER TABLE "WebhookEndpoint"
    ADD COLUMN "scopeMask" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "cursorReviewRequired" BOOLEAN NOT NULL DEFAULT false;
