-- One row per running API server, upserted every 30 seconds with its version and what it supports. Nothing reads it in
-- 0.3; the release that runs retention without the ingest lock (#296) uses it to see every server before relying on
-- them. Rows not seen for a day are pruned.
CREATE TABLE "ServerHeartbeat" (
    "instanceId" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '',
    "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text),
    CONSTRAINT "ServerHeartbeat_pkey" PRIMARY KEY ("instanceId")
);

CREATE INDEX "ServerHeartbeat_seenAt_idx" ON "ServerHeartbeat"("seenAt");
