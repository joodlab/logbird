import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prisma } from '@logbird/database';

// Read-only migration verdict. Run: node --env-file=.env --import tsx scripts/verify-export-migration.ts [baseline.json]
try {
  const columns = await prisma.$queryRaw<
    { table_name: string; column_name: string; is_nullable: string }[]
  >`SELECT table_name,column_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('AuditOutbox','Project','ExportLease')`;
  for (const [table, name] of [
    ['AuditOutbox', 'awaitingUntil'],
    ['AuditOutbox', 'pendingOutcome'],
    ['Project', 'exportDeleteStartedAt'],
    ['Project', 'exportGeneration'],
    ['ExportLease', 'weight'],
  ])
    assert.ok(
      columns.some((c) => c.table_name === table && c.column_name === name),
      `${table}.${name}`,
    );
  for (const name of ['awaitingUntil', 'pendingOutcome'])
    assert.equal(columns.find((c) => c.table_name === 'AuditOutbox' && c.column_name === name)?.is_nullable, 'YES');
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  const counts: Record<string, number> = {};
  for (const { tablename } of tables)
    counts[tablename] = Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) n FROM "${tablename.replaceAll('"', '""')}"`))[0]?.n);
  const baseline = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')).counts : undefined;
  if (baseline) for (const table of Object.keys(baseline)) assert.ok(table in counts, `Original table missing: ${table}`);
  console.log(
    JSON.stringify(
      { at: new Date().toISOString(), additiveColumnsPresent: true, originalTablesPresent: Boolean(baseline), counts, baselineCounts: baseline },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
