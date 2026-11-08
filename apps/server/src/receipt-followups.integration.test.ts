import {
  confirmIngestReceipts,
  confirmIngestReceiptsSql,
  expireIngestReceiptsSql,
  findIngestReceipts,
  findIngestReceiptsSql,
  Prisma,
  prisma,
  pruneIngestReceipts,
  RECEIPT_SEEK_GUARD,
  sweepIngestReceipts,
} from '@logbird/database';
import { recoverProjectIngest } from '@logbird/worker/ingest-recovery';
import { enforceProjectRetention } from '@logbird/worker/retention';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { app } from './app';
import { maintenanceClickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });
let f: ImmutableFixture,
  clock = Date.now();
beforeEach(async () => {
  f = await immutableFixture();
  // Each test starts past the process-wide flush throttle window.
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = Math.max(clock, Date.now()) + 61_000;
  vi.setSystemTime(clock);
});
afterEach(async () => {
  clock = Math.max(clock, Date.now());
  vi.useRealTimers();
  vi.restoreAllMocks();
  await f.cleanup();
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
async function receipt(eventId: string, data: { confirmedAt?: Date | null; claimedAt?: Date | null; projectId?: string } = {}) {
  await prisma.ingestReceipt.create({
    data: {
      projectId: data.projectId ?? f.project,
      organizationId: f.org,
      eventId,
      fingerprint: 'v1:fixture',
      receivedAt: minutesAgo(30),
      eventAt: minutesAgo(30),
      confirmedAt: data.confirmedAt ?? null,
      claimedAt: data.claimedAt ?? null,
    },
  });
}
/** Polls until another backend waits on a lock that `pid` holds: a real barrier, not a sleep. */
async function blockedBy(pid: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int n FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`;
    if (row?.n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('No backend waited on the fixture row lock');
}
/** Each pooled connection must report its session defaults after transaction-local guards. */
async function poolSettingsAreDefaults() {
  const poolSize = Number(new URL(process.env.DATABASE_URL as string).searchParams.get('connection_limit') ?? 10);
  let arrived = 0;
  let release: () => void = () => undefined;
  const all = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rows = await Promise.all(
    Array.from({ length: poolSize }, () =>
      prisma.$transaction(
        async (tx) => {
          const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() pid`;
          const settings = await tx.$queryRaw<{ name: string; setting: string; reset_val: string }[]>`
            SELECT name, setting, reset_val FROM pg_settings WHERE name IN ('statement_timeout','lock_timeout','enable_bitmapscan')`;
          // Hold every connection at once so the whole pool, including the sweep's connection, is inspected.
          if (++arrived === poolSize) release();
          await all;
          return { pid: backend?.pid, settings };
        },
        { maxWait: 10_000, timeout: 20_000 },
      ),
    ),
  );
  expect(new Set(rows.map((r) => r.pid)).size).toBe(poolSize);
  for (const { settings } of rows) {
    expect(settings).toHaveLength(3);
    for (const s of settings) expect(s.setting).toBe(s.reset_val);
    expect(settings.find((s) => s.name === 'enable_bitmapscan')?.setting).toBe('on');
  }
}

it('the minute sweep and hourly backstop delete only expired confirmed receipts in scope, then restore session settings', async () => {
  const neighbor = `${f.project}-neighbor`;
  await prisma.project.create({ data: { id: neighbor, organizationId: f.org, name: 'QA Receipt neighbor', slug: neighbor } });
  await receipt('expired', { confirmedAt: minutesAgo(20) });
  await receipt('fresh', { confirmedAt: minutesAgo(1) });
  await receipt('unresolved-claim', { claimedAt: minutesAgo(20) });
  await receipt('ready', {});
  await receipt('neighbor-expired', { confirmedAt: minutesAgo(20), projectId: neighbor });
  expect(await sweepIngestReceipts(f.project)).toEqual({ removed: 1, batches: 1, limited: false });
  const left = async (projectId: string) =>
    (await prisma.ingestReceipt.findMany({ where: { projectId }, select: { eventId: true }, orderBy: { eventId: 'asc' } })).map((r) => r.eventId);
  expect(await left(f.project)).toEqual(['fresh', 'ready', 'unresolved-claim']);
  expect(await left(neighbor)).toEqual(['neighbor-expired']);
  await poolSettingsAreDefaults();
  // The guarded backstop shares the batch path; an expired confirmation in another scoped project is next.
  expect(await pruneIngestReceipts(neighbor)).toEqual({ removed: 1, batches: 1, limited: false });
  expect(await left(neighbor)).toEqual([]);
  expect(await left(f.project)).toEqual(['fresh', 'ready', 'unresolved-claim']);
  await poolSettingsAreDefaults();
});

it('confirmation re-seeks a receipt that a concurrent writer moved between its seek and row lock', async () => {
  await receipt('moved', { confirmedAt: minutesAgo(20) });
  let confirmation: Promise<void> | undefined;
  await prisma.$transaction(
    async (tx) => {
      // The concurrent writer creates a new tuple version (new ctid) and holds the old one locked.
      await tx.$executeRaw`UPDATE "IngestReceipt" SET "fingerprint"='v1:concurrent' WHERE "projectId"=${f.project} AND "eventId"='moved'`;
      const [writer] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() pid`;
      confirmation = confirmIngestReceipts(f.project, [
        { eventId: 'moved', fingerprint: 'v1:confirmed', receivedAt: new Date(1), eventAt: new Date(2) },
      ]);
      void confirmation.catch(() => undefined); // Awaited below, after this writer commits.
      await blockedBy(writer?.pid as number);
    },
    { timeout: 20_000 },
  );
  await confirmation;
  const [stored] = await findIngestReceipts(f.project, ['moved']);
  // The old ctid-only statement silently skipped this row and kept the concurrent fingerprint.
  expect(stored).toMatchObject({ fingerprint: 'v1:confirmed', receivedAt: new Date(1), eventAt: new Date(2) });
  expect(stored?.confirmedAt?.getTime()).toBe(Date.now());
});

type PlanNode = { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string; 'Index Cond'?: string; Plans?: PlanNode[] };
function nodes(node: PlanNode, parent?: PlanNode): { node: PlanNode; parent?: PlanNode }[] {
  return [{ node, parent }, ...(node.Plans ?? []).flatMap((child) => nodes(child, node))];
}
it('every per-id receipt probe stays an ordered primary-key seek', async () => {
  // Enough rows that a per-id equality probe on a project index would be a visible alternative.
  await prisma.$executeRaw`INSERT INTO "IngestReceipt" ("projectId","organizationId","eventId","fingerprint","receivedAt","eventAt","confirmedAt","claimedAt")
    SELECT ${f.project}, ${f.org}, 'plan-' || lpad(n::text, 6, '0'), 'v1:fixture', now(), now(), now() - interval '20 minutes', NULL
    FROM generate_series(1, 5000) n`;
  const ids = Array.from({ length: 1000 }, (_, n) => `plan-${String(n * 5 + 1).padStart(6, '0')}`);
  const identity = { fingerprint: 'v1:fixture', receivedAt: new Date(), eventAt: new Date() };
  for (const [label, sql] of [
    ['find', findIngestReceiptsSql(f.project, ids)],
    [
      'confirm',
      confirmIngestReceiptsSql(
        f.project,
        ids.map((eventId) => ({ eventId, ...identity })),
        new Date(),
      ),
    ],
    ['expire', expireIngestReceiptsSql(f.project, ids, new Date())],
  ] as const) {
    // Planned exactly as production runs it: under the transaction-local seek guard.
    const [, [row]] = await prisma.$transaction([
      prisma.$executeRaw(RECEIPT_SEEK_GUARD),
      prisma.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(Prisma.sql`EXPLAIN (FORMAT JSON) ${sql}`),
    ]);
    // A bloated, nearly empty table inflates costs past jit_above_cost; OLTP probes must never compile.
    expect(row?.['QUERY PLAN'][0], label).not.toHaveProperty('JIT');
    const all = nodes(row?.['QUERY PLAN'][0]?.Plan as PlanNode);
    const receipts = all.filter(({ node }) => node['Relation Name'] === 'IngestReceipt' && node['Node Type'] !== 'ModifyTable');
    expect(receipts.length, label).toBeGreaterThan(0);
    for (const { node } of receipts) {
      // No per-id secondary-index filter and no scan of the project's history.
      expect(['Index Scan', 'Index Only Scan', 'Tid Scan'], `${label}: ${node['Node Type']}`).toContain(node['Node Type']);
      if (node['Index Name']) expect(node['Index Name'], label).toBe('IngestReceipt_pkey');
    }
    const seeks = all.filter(({ node, parent }) => node['Index Name'] === 'IngestReceipt_pkey' && parent?.['Node Type'] === 'Limit');
    expect(seeks.length, `${label} keeps the LIMIT 1 key seek`).toBeGreaterThan(0);
    for (const { node } of seeks) expect(node['Index Cond'], label).toMatch(/ROW\("projectId", "eventId"\) >= ROW\(/);
  }
});

/** Holds the project's data lock (not its writer gate) in a separate transaction until released. */
function holdDataLock(projectId: string) {
  let release: () => void = () => undefined;
  let held: (pid: number) => void = () => undefined;
  const pid = new Promise<number>((resolve) => {
    held = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0))) AS locked`;
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() pid`;
      held(backend?.pid as number);
      await released;
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
  return {
    pid,
    release: async () => {
      release();
      await done;
    },
  };
}
/** Resolves once another session holds the project's writer gate: an exclusive locker now waits for data. */
async function gateWaiter(holderPid: number, projectId: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int n FROM pg_locks l, (SELECT hashtextextended(${projectId}, 1) k) gate
      WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1 AND l.pid<>${holderPid}
        AND l.classid::bigint=(gate.k>>32)&4294967295 AND l.objid::bigint=gate.k&4294967295`;
    if (row?.n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Recovery never waited for the project lock');
}

it('re-checks failed repairs inside the exclusive lock: a repair that fails while recovery waits wins', async () => {
  const abandoned = await f.pending({ id: 'abandoned', action: 'repair.pending' }, { expired: true });
  const generation = (await prisma.project.findUniqueOrThrow({ where: { id: f.project } })).maintenanceGeneration;
  const holder = holdDataLock(f.project);
  let recovery: Promise<boolean> | undefined;
  try {
    const holderPid = await holder.pid;
    recovery = recoverProjectIngest(maintenanceClickhouse, f.project);
    await gateWaiter(holderPid, f.project);
    // The lock holder's repair fails while this recovery is waiting for the lock.
    await prisma.retentionRun.create({
      data: {
        projectId: f.project,
        kind: 'ingest_repair',
        retentionDays: 30,
        cutoff: new Date(0),
        status: 'failed',
        finishedAt: new Date(),
        error: 'QA fixture repair failure',
      },
    });
  } finally {
    await holder.release();
  }
  expect(await recovery).toBe(false);
  // No second repair started and the abandoned claim stays for retention, untouched.
  expect(await prisma.retentionRun.findMany({ where: { projectId: f.project }, select: { kind: true, status: true } })).toEqual([
    { kind: 'ingest_repair', status: 'failed' },
  ]);
  expect((await prisma.project.findUniqueOrThrow({ where: { id: f.project } })).maintenanceGeneration).toBe(generation);
  const [stored] = await findIngestReceipts(f.project, [abandoned.event_id]);
  expect(stored).toMatchObject({ confirmedAt: null });
  expect(stored?.claimedAt).not.toBeNull();
});

it('retention that completes a failed repair also settles its receipts, so the retry needs no second rebuild', async () => {
  await f.authorize();
  const pending = { id: 'abandoned', action: 'repair.pending' };
  expect((await f.post({ id: 'retained', action: 'retained.event', actor: { id: 'person', type: 'user' } })).status).toBe(202);
  await f.pending(pending, { expired: true });
  const command = maintenanceClickhouse.command.bind(maintenanceClickhouse);
  const failing = vi.spyOn(maintenanceClickhouse, 'command').mockImplementation(async (params) => {
    const result = await command(params);
    if (params.query.startsWith('DELETE FROM attribute_keys')) throw Object.assign(new Error('QA rebuild memory limit'), { code: '241' });
    return result;
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect((await f.post([pending])).status).toBe(503);
  expect(await prisma.retentionRun.count({ where: { projectId: f.project, kind: 'ingest_repair', status: 'failed' } })).toBe(1);
  failing.mockRestore();

  const ready = await app.request('/readyz');
  expect(ready.status).toBe(200);
  const { maintenance } = await ready.json();
  expect(maintenance.failedIngestRepairs.fencedProjects).toBeGreaterThanOrEqual(1);
  expect(Date.parse(maintenance.failedIngestRepairs.oldestFailedAt)).not.toBeNaN();
  expect(JSON.stringify(maintenance)).not.toContain(f.project);

  await enforceProjectRetention(f.project);
  expect(await prisma.retentionRun.count({ where: { projectId: f.project, kind: 'ingest_repair', status: { in: ['running', 'failed'] } } })).toBe(0);
  // The abandoned write never reached storage: retention readied its receipt for an exact replay.
  const [settled] = await findIngestReceipts(f.project, ['abandoned']);
  expect(settled).toMatchObject({ confirmedAt: null, claimedAt: null });

  const rebuilds = vi.spyOn(maintenanceClickhouse, 'command');
  const retry = await f.post([pending]);
  expect(retry.status).toBe(202);
  expect(rebuilds.mock.calls.filter(([p]) => /^DELETE FROM (events_by_minute|entities|attribute_keys)\b/.test(p.query))).toHaveLength(0);
  expect(await prisma.retentionRun.count({ where: { projectId: f.project, kind: 'ingest_repair' } })).toBe(1);
  expect(await f.count()).toBe(2);
});
