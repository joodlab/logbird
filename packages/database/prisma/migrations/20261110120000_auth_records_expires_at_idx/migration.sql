-- The hourly sweep of expired authentication records (#129) selects and orders by "expiresAt".
-- Additive only: no rows change.
CREATE INDEX IF NOT EXISTS "session_expiresAt_idx" ON "session"("expiresAt");
CREATE INDEX IF NOT EXISTS "verification_expiresAt_idx" ON "verification"("expiresAt");
CREATE INDEX IF NOT EXISTS "invitation_expiresAt_idx" ON "invitation"("expiresAt");
