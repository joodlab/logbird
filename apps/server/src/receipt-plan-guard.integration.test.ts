import { randomUUID } from 'node:crypto';
import {
  confirmIngestReceiptsSql,
  expireIngestReceiptsSql,
  findIngestReceiptsSql,
  Prisma,
  prisma,
  pruneReceiptBatchSql,
  RECEIPT_SEEK_GUARD,
  SWEEP_GUARD,
} from '@logbird/database';
import { expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 300_000 });

type PlanNode = { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string; 'Index Cond'?: string; Plans?: PlanNode[] };
type Plan = { Plan: PlanNode; JIT?: unknown };
const flat = (node: PlanNode, parent?: PlanNode): { node: PlanNode; parent?: PlanNode }[] => [
  { node, parent },
  ...(node.Plans ?? []).flatMap((child) => flat(child, node)),
];
const RESET = Prisma.sql`SELECT set_config('enable_seqscan','on',true), set_config('enable_bitmapscan','on',true),
  set_config('enable_sort','on',true), set_config('enable_incremental_sort','on',true), set_config('jit','on',true), set_config('statement_timeout','0',true)`;

/**
 * Runs inside one transaction against a session-local temp "IngestReceipt" (same columns and indexes) that
 * shadows the shared table for unqualified names, so the shipped SQL is planned against an owned fixture.
 * Nothing shared is written, vacuumed or reindexed; ON COMMIT DROP removes the fixture.
 */
it('receipt probes and sweep batches stay index-driven with fresh, large, stale and bloated statistics', async () => {
  const project = `qa-plan-${randomUUID()}`;
  const ids = Array.from({ length: 1000 }, () => randomUUID()).sort();
  const identity = { fingerprint: 'v1:fixture', receivedAt: new Date(), eventAt: new Date() };
  const cutoff = new Date(Date.now() - 600_000);
  const probes = {
    find: findIngestReceiptsSql(project, ids),
    confirm: confirmIngestReceiptsSql(
      project,
      ids.map((eventId) => ({ eventId, ...identity })),
      new Date(),
    ),
    expire: expireIngestReceiptsSql(project, ids, cutoff),
  };
  const sweeps = { scoped: pruneReceiptBatchSql(project, cutoff.toISOString()), global: pruneReceiptBatchSql(undefined, cutoff.toISOString()) };
  const evidence: Record<string, unknown> = {};
  await prisma.$transaction(
    async (tx) => {
      const plan = async (sql: Prisma.Sql) =>
        (await tx.$queryRaw<{ 'QUERY PLAN': Plan[] }[]>(Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`))[0]?.['QUERY PLAN'][0] as Plan;
      const receiptScans = (p: Plan) =>
        flat(p.Plan).filter(({ node }) => node['Relation Name'] === 'IngestReceipt' && node['Node Type'] !== 'ModifyTable');
      const assertGuarded = async (state: string) => {
        await tx.$executeRaw(RECEIPT_SEEK_GUARD);
        for (const [label, sql] of Object.entries(probes)) {
          const p = await plan(sql);
          expect(p, `${state}/${label}: no JIT`).not.toHaveProperty('JIT');
          const scans = receiptScans(p);
          expect(scans.length, `${state}/${label}`).toBeGreaterThan(0);
          for (const { node } of scans) {
            expect(['Index Scan', 'Index Only Scan', 'Tid Scan'], `${state}/${label}: ${node['Node Type']}`).toContain(node['Node Type']);
            if (node['Index Name']) expect(node['Index Name'], `${state}/${label}`).toMatch(/_pkey$/);
          }
          const seeks = scans.filter(({ parent }) => parent?.['Node Type'] === 'Limit');
          expect(seeks.length, `${state}/${label}: LIMIT 1 key seek`).toBeGreaterThan(0);
          for (const { node } of seeks) expect(node['Index Cond']).toMatch(/ROW\("projectId", "eventId"\) >= ROW\(/);
        }
        await tx.$executeRaw(RESET);
        await tx.$executeRaw(SWEEP_GUARD);
        for (const [label, sql] of Object.entries(sweeps)) {
          const p = await plan(sql);
          expect(p, `${state}/sweep-${label}: no JIT`).not.toHaveProperty('JIT');
          const nodes = flat(p.Plan).map(({ node }) => node);
          expect(
            nodes.map((n) => n['Node Type']),
            `${state}/sweep-${label}`,
          ).not.toContain('Sort');
          const scan = receiptScans(p).find(({ node }) => node['Index Name'])?.node;
          expect(scan?.['Index Name'], `${state}/sweep-${label}`).toMatch(/confirmedAt/);
          for (const { node } of receiptScans(p)) expect(['Index Scan', 'Index Only Scan', 'Tid Scan']).toContain(node['Node Type']);
        }
        await tx.$executeRaw(RESET);
      };
      const unguardedFind = async () =>
        receiptScans(await plan(probes.find)).map(({ node }) => `${node['Node Type']}${node['Index Name'] ? `:${node['Index Name']}` : ''}`);
      const insert = (rows: number, confirmed: string) =>
        tx.$executeRaw(Prisma.sql`INSERT INTO "IngestReceipt" ("projectId","organizationId","eventId","fingerprint","receivedAt","eventAt","confirmedAt","claimedAt")
          SELECT ${project}, 'qa-plan-org', gen_random_uuid()::text, 'v1:' || md5(n::text), now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC',
            now() AT TIME ZONE 'UTC' - ${Prisma.raw(`interval '${confirmed}'`)}, NULL FROM generate_series(1, ${rows}) n`);

      await tx.$executeRaw`CREATE TEMP TABLE "IngestReceipt" (LIKE public."IngestReceipt" INCLUDING ALL) ON COMMIT DROP`;
      const [resolved] = await tx.$queryRaw<{ schema: string }[]>`SELECT n.nspname schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid='"IngestReceipt"'::regclass`;
      expect(resolved?.schema).toMatch(/^pg_temp/);

      // Fresh, never-analyzed statistics (temp tables are never auto-analyzed).
      await insert(20_000, '20 minutes');
      evidence.freshUnguarded = await unguardedFind();
      await assertGuarded('fresh');
      // Large table with current statistics.
      await insert(380_000, '1 minute');
      await tx.$executeRaw`ANALYZE pg_temp."IngestReceipt"`;
      evidence.largeUnguarded = await unguardedFind();
      await assertGuarded('large');
      // Stale statistics: the table grows 2x after ANALYZE.
      await insert(400_000, '20 minutes');
      evidence.staleUnguarded = await unguardedFind();
      await assertGuarded('stale');
      // Bloated and nearly empty: ~800k rows deleted, 5 kept, statistics refreshed, no VACUUM FULL.
      await tx.$executeRaw`DELETE FROM "IngestReceipt" WHERE ctid NOT IN (SELECT ctid FROM "IngestReceipt" LIMIT 5)`;
      await tx.$executeRaw`ANALYZE pg_temp."IngestReceipt"`;
      const [shape] = await tx.$queryRaw<
        { reltuples: number; relpages: number }[]
      >`SELECT reltuples::int, relpages FROM pg_class WHERE oid='"IngestReceipt"'::regclass`;
      evidence.bloated = shape;
      expect(shape?.reltuples).toBeLessThan(100);
      expect(shape?.relpages).toBeGreaterThan(5000);
      // The fixture reproduces the hazard: unguarded, the planner abandons the ordered primary-key seek. The
      // replacement depends on exact page counts: a secondary-index, bitmap or sequential scan plus a sort per id.
      evidence.bloatedUnguarded = await unguardedFind();
      expect(evidence.bloatedUnguarded).not.toEqual(['Index Scan:IngestReceipt_pkey']);
      await assertGuarded('bloated');
    },
    { maxWait: 10_000, timeout: 280_000 },
  );
  console.log(JSON.stringify({ event: 'qa.receipt_plan_guard', evidence }));
});
