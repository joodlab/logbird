ALTER TABLE "WebhookEndpoint" ADD COLUMN "scanAttemptedAt" TIMESTAMP(3);

CREATE INDEX "WebhookEndpoint_enabled_scanAttemptedAt_id_idx"
  ON "WebhookEndpoint" ("enabled", "scanAttemptedAt" NULLS FIRST, "id");
