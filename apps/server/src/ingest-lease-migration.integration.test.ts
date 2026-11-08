import { readFile } from 'node:fs/promises';
import { prisma } from '@logbird/database';
import { expect, it } from 'vitest';

it('applies the actual lease migrations in a non-UTC session without changing receipt clocks', async () => {
  const original = await readFile(
    new URL('../../../packages/database/prisma/migrations/20261107140000_ingest_claim_lease/migration.sql', import.meta.url),
    'utf8',
  );
  const correction = await readFile(
    new URL('../../../packages/database/prisma/migrations/20261107160000_ingest_utc_lease/migration.sql', import.meta.url),
    'utf8',
  );
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `CREATE TEMP TABLE "IngestReceipt" ("projectId" text,"eventId" text,"confirmedAt" timestamp(3),"receivedAt" timestamp(3),"eventAt" timestamp(3)) ON COMMIT DROP`,
    );
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Pacific/Auckland'`);
    await tx.$executeRawUnsafe(
      `INSERT INTO "IngestReceipt" ("projectId","eventId","receivedAt","eventAt") VALUES ('qa','pending','2026-11-01 12:00:00','2026-10-31 12:00:00')`,
    );
    for (const query of original
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await tx.$executeRawUnsafe(query);
    const before = await tx.$queryRawUnsafe<{ seconds: number }[]>(
      `SELECT extract(epoch FROM ("claimedAt"-(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')))::float8 seconds FROM "IngestReceipt"`,
    );
    expect(Math.abs(before[0]?.seconds ?? 0)).toBeGreaterThan(3600);
    for (const query of correction
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await tx.$executeRawUnsafe(query);
    await tx.$executeRawUnsafe(
      `INSERT INTO "IngestReceipt" ("projectId","eventId","receivedAt","eventAt") VALUES ('qa','default','2026-11-01 12:00:00','2026-10-31 12:00:00')`,
    );
    const rows = await tx.$queryRawUnsafe<{ seconds: number; receipt: string; event: string }[]>(
      `SELECT extract(epoch FROM ("claimedAt"-(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')))::float8 seconds,to_char("receivedAt",'YYYY-MM-DD HH24:MI:SS') receipt,to_char("eventAt",'YYYY-MM-DD HH24:MI:SS') event FROM "IngestReceipt"`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Math.abs(row.seconds)).toBeLessThan(1);
      expect(row.receipt).toBe('2026-11-01 12:00:00');
      expect(row.event).toBe('2026-10-31 12:00:00');
    }
  });
});
