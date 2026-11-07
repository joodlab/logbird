import { randomUUID } from 'node:crypto';
import { insertEvents, normalizeEvent } from '@logbird/clickhouse';
import { closeProjectLocks, prisma, withProjectLock } from '@logbird/database';
import { clickhouse, purgeProjectEvents } from '../apps/server/src/clickhouse';
import { type IngestCandidate, insertImmutableEvents } from '../apps/server/src/immutable-ingest';

// Opt-in benchmark. Hold the shared heavy slot and check RAM before running.
// 1M receipts in an owned table, then paired 1000-event ClickHouse INSERTs (20 samples).
const org = randomUUID();
const table = `qa_receipts_${org.replaceAll('-', '')}`;
const project = `qa-identity-${org}`;
const baseline = `${project}-baseline`;
const batchSize = 1000;
const p95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
const timed = async (work: () => Promise<unknown>) => {
  const start = performance.now();
  await work();
  return performance.now() - start;
};
try {
  await prisma.organization.create({ data: { id: org, name: 'QA Immutable benchmark', slug: org, createdAt: new Date() } });
  // All identifiers are generated here, never accepted from CLI/environment.
  await prisma.$executeRawUnsafe(`CREATE TABLE ${table} (LIKE "IngestReceipt" INCLUDING ALL)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE ${table} ADD FOREIGN KEY ("organizationId") REFERENCES "organization"(id)`);
  const claims: number[] = [];
  for (let batch = 0; batch < 1000; batch++) {
    const ids = Array.from({ length: batchSize }, () => randomUUID());
    claims.push(
      await timed(() =>
        prisma.$queryRawUnsafe(
          `INSERT INTO ${table}
      ("projectId","eventId","organizationId","fingerprint","receivedAt","eventAt","confirmedAt")
      SELECT $1,id,$2,repeat('f',64),now(),now(),now() FROM unnest($3::text[]) id
      ON CONFLICT ("projectId","eventId") DO NOTHING RETURNING "eventId"`,
          project,
          org,
          ids,
        ),
      ),
    );
    if ((batch + 1) % 100 === 0) console.log(JSON.stringify({ receiptRows: (batch + 1) * batchSize }));
  }
  const size = await prisma.$queryRawUnsafe(`SELECT pg_relation_size('${table}')::float8 heap_bytes,
    pg_table_size('${table}')::float8 table_bytes,pg_indexes_size('${table}')::float8 index_bytes,
    pg_total_relation_size('${table}')::float8 total_bytes`);
  const rawMs: number[] = [],
    fencedMs: number[] = [],
    addedMs: number[] = [];
  for (let batch = 0; batch < 21; batch++) {
    const now = new Date();
    const candidates: IngestCandidate[] = Array.from({ length: batchSize }, (_, index) => {
      const input = { id: randomUUID(), action: 'benchmark.immutable', occurredAt: now.toISOString(), actor: { id: 'fictional' } };
      const normalized = normalizeEvent(input, { projectId: project, receivedAt: now });
      if (!normalized.ok) throw new Error('Invalid fixture');
      return { index, input, row: normalized.row };
    });
    const rawRows = candidates.map(({ row }) => ({ ...row, project_id: baseline }));
    const raw = () => withProjectLock(baseline, () => insertEvents(clickhouse, rawRows), { mode: 'shared' });
    const fenced = () => withProjectLock(project, () => insertImmutableEvents(project, org, candidates), { mode: 'shared' });
    let rawTime: number, fencedTime: number;
    if (batch % 2 === 0) {
      rawTime = await timed(raw);
      fencedTime = await timed(fenced);
    } else {
      fencedTime = await timed(fenced);
      rawTime = await timed(raw);
    }
    if (batch) {
      rawMs.push(rawTime);
      fencedMs.push(fencedTime);
      addedMs.push(fencedTime - rawTime);
    }
  }
  console.log(
    JSON.stringify({
      receiptRows: 1_000_000,
      batchSize,
      receiptBulkClaimP95Ms: p95(claims),
      size,
      samples: rawMs.length,
      rawP95Ms: p95(rawMs),
      fencedP95Ms: p95(fencedMs),
      pairedAddedP95Ms: p95(addedMs),
      rawMs,
      fencedMs,
      addedMs,
    }),
  );
} finally {
  await withProjectLock(project, () => purgeProjectEvents(project));
  await withProjectLock(baseline, () => purgeProjectEvents(baseline));
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table}`);
  await prisma.organization.deleteMany({ where: { id: org } });
  await clickhouse.close();
  await closeProjectLocks();
  await prisma.$disconnect();
}
