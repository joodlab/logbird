-- Separate generation identity from occurrence buckets. Preserve every existing counter and payload.
ALTER TABLE "AuthAuditWindow" ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
-- Uniform namespace/hour fencing: request admission never needs an account or membership lookup.
CREATE TABLE "AuthAuditAdmission" (
  id TEXT NOT NULL PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT '{logbird}',
  "windowEnd" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "AuthAuditAdmission_namespace_windowEnd_idx" ON "AuthAuditAdmission" (namespace, "windowEnd");
