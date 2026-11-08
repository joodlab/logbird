-- The existing restricted SQL profile has immutable 1-GiB budgets; reserve both export slots for it.
ALTER TABLE "ExportLease" ADD COLUMN "weight" INTEGER NOT NULL DEFAULT 1;
