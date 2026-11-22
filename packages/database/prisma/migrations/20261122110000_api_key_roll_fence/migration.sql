-- Rollback safety for restricted API keys (#138). Changes no data and no columns.
-- Releases before scoped read keys don't know about ApiKey.scope or ApiKey.expiresAt: their "roll key" would create a
-- replacement without them, turning a tenant-scoped or expiring key into a permanent project-wide one. This trigger
-- refuses any INSERT that replaces a key unless it keeps the old key's scope, and has an expiry when the old key had
-- one. Current servers enforce the same rule in the API first; this is the backstop. Never drop it in a migration
-- (guarded by packages/database/src/migrations-guard.test.ts).
CREATE OR REPLACE FUNCTION "logbird_api_key_roll_fence"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  replaced "ApiKey"%ROWTYPE;
BEGIN
  IF NEW."replacesKeyId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO replaced FROM "ApiKey" WHERE "id" = NEW."replacesKeyId";
  IF FOUND AND (replaced."scope" IS DISTINCT FROM NEW."scope" OR (replaced."expiresAt" IS NOT NULL AND NEW."expiresAt" IS NULL)) THEN
    RAISE EXCEPTION 'logbird_api_key_roll_fence: a replacement key must keep the scope and the expiry of the key it replaces'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ApiKey_roll_fence" BEFORE INSERT ON "ApiKey" FOR EACH ROW EXECUTE FUNCTION "logbird_api_key_roll_fence"();
