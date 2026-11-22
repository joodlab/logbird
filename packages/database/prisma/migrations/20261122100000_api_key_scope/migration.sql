-- Additive (#138): scoped read keys, viewer-token CORS origins and optional key expiry.
-- New nullable / defaulted columns only; existing keys keep their meaning (scope NULL = unscoped).
ALTER TABLE "ApiKey" ADD COLUMN "scope" JSONB;
ALTER TABLE "ApiKey" ADD COLUMN "embedOrigins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ApiKey" ADD COLUMN "expiresAt" TIMESTAMP(3);
