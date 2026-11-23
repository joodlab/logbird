-- When a worker last claimed a webhook delivery for each project. Claims rotate across projects, least recently claimed
-- first; a project without a row ranks before all others.
CREATE TABLE "WebhookClaimRotation" (
    "projectId" TEXT NOT NULL,
    "lastClaimedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WebhookClaimRotation_pkey" PRIMARY KEY ("projectId")
);

ALTER TABLE "WebhookClaimRotation" ADD CONSTRAINT "WebhookClaimRotation_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
