-- Additive reporting watermarks and per-budget recovery. Existing counters/payloads remain unchanged.
ALTER TABLE "AuthAuditBudget"
  ADD COLUMN "reportedSuppressed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN generation INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reportedTargets" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "targetWatermarkComplete" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "prepareAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "quarantinedAt" TIMESTAMP(3);
CREATE INDEX "AuthAuditBudget_due_idx"
  ON "AuthAuditBudget" (namespace, reported, "quarantinedAt", "nextAttemptAt", "windowEnd");
-- A reported row's full counters are already durably represented, even if delivery is still pending.
UPDATE "AuthAuditBudget" SET "reportedSuppressed"=suppressed, "reportedTargets"=targets WHERE reported;
-- Recover an old row reopened after its fixed-id summary. Do not count its previous payload twice.
UPDATE "AuthAuditBudget" b SET
  "reportedSuppressed"=LEAST(b.suppressed, GREATEST(0, (o.payload#>>'{metadata,attempts}')::numeric))::integer,
  "reportedTargets"=COALESCE((SELECT jsonb_object_agg(t->>'userId', t->'attempts')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o.payload#>'{metadata,targets}')='array'
      THEN o.payload#>'{metadata,targets}' ELSE '[]'::jsonb END) t
    WHERE jsonb_typeof(t->'userId')='string' AND jsonb_typeof(t->'attempts')='number'), '{}'::jsonb),
  "targetWatermarkComplete"=COALESCE(jsonb_typeof(o.payload#>'{metadata,targets}')='array', false)
    AND COALESCE(o.payload#>'{metadata,targetsTruncated}', 'true'::jsonb)='false'::jsonb
FROM "AuditOutbox" o WHERE NOT b.reported AND o.id='auth-suppression-'||b.id
  AND jsonb_typeof(o.payload#>'{metadata,attempts}')='number';
