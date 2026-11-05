ALTER TABLE "RetentionRun" ADD COLUMN "heartbeatAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
UPDATE "RetentionRun" SET "heartbeatAt" = "startedAt";
