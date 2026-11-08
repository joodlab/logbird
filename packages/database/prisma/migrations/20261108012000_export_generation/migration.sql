-- Covers sample replacement as well as retention, including failed partial maintenance.
ALTER TABLE "Project" ADD COLUMN "exportGeneration" INTEGER NOT NULL DEFAULT 0;
