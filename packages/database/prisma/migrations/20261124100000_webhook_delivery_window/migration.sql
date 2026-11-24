-- Webhook delivery window (#152): deliver an event only if it arrived no later than the window after it occurred.
-- Existing endpoints get the 7-day default (DEFAULT_WEBHOOK_DELIVERY_WINDOW_SECONDS in packages/contracts; a test checks
-- this value). This is safe only because webhook delivery first ships in the same release; NULL means no limit.
-- The window default fills existing rows and is then dropped, so the server always sets the window explicitly.
ALTER TABLE "WebhookEndpoint" ADD COLUMN "deliveryWindowSeconds" INTEGER DEFAULT 604800;
ALTER TABLE "WebhookEndpoint" ALTER COLUMN "deliveryWindowSeconds" DROP DEFAULT;
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_deliveryWindowSeconds_check"
  CHECK ("deliveryWindowSeconds" IS NULL OR ("deliveryWindowSeconds" BETWEEN 3600 AND 315360000 AND "deliveryWindowSeconds" % 3600 = 0));
-- When the window last changed: the late-event count starts at the later of this and 30 days ago.
ALTER TABLE "WebhookEndpoint" ADD COLUMN "deliveryWindowChangedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
