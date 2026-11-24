-- One row per running API server, upserted every 30 seconds with what it supports (#296). Background retention runs
-- only while every server seen recently declares it; rows not seen for a day are pruned.
CREATE TABLE "ServerHeartbeat" (
    "instanceId" TEXT NOT NULL,
    "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'::text),
    CONSTRAINT "ServerHeartbeat_pkey" PRIMARY KEY ("instanceId")
);

CREATE INDEX "ServerHeartbeat_seenAt_idx" ON "ServerHeartbeat"("seenAt");
