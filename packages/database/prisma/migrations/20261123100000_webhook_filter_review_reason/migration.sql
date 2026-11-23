-- Distinguish a stored filter that cannot run (held by discovery) from the upgrade review of pre-delivery filters.
ALTER TABLE "WebhookEndpoint" ADD COLUMN "filterReviewReason" TEXT;
