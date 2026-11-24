-- Derived-table drift baselines a background retention run records before its DELETEs and compares at completion
-- (#296). Null for runs from before this column: those are never reported as verified.
ALTER TABLE "RetentionRun" ADD COLUMN "verification" JSONB;
