-- Additive: key rotation link and last-used client. Both nullable; existing keys and master code are unaffected.
ALTER TABLE "ApiKey" ADD COLUMN "lastUsedUserAgent" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "replacesKeyId" TEXT;
