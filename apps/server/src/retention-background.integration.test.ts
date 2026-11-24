import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { CLICKHOUSE_PLAIN_READ, insertEvents, pendingProjectMutations, read } from '@logbird/clickhouse';
import { closeProjectLocks, ProjectBusyError, prisma, SERVER_CAPABILITIES, withProjectLock } from '@logbird/database';
import { RETENTION_CLOCK_SKEW_ALLOWANCE_MS, runBackgroundRetention } from '@logbird/worker/retention';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clickhouse, maintenanceClickhouse } from './clickhouse';
import { reconcileDestructiveMaintenance } from './destructive-maintenance';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';
import { beginRollupRead } from './project-read';
import { purgeLimit, slowStore } from './slow-store';

// The hourly retention run never holds the project lock across ClickHouse mutations (#268): ingest waits only for its
// two short fences, and nothing deleted or refused is counted or shown wrongly at any phase.
const DAY = 86_400_000;
let f: ImmutableFixture;
// The capability gate (#296): background retention runs only while a server that supports it is seen.
const serverInstance = `qa-retention-bg-${randomUUID()}`;
beforeEach(async () => {
  f = await immutableFixture('qa-retention-bg');
  await prisma.project.update({ where: { id: f.project }, data: { retentionDays: 30 } });
  // Seen an hour ahead, so a slow test never outlives the 90-second window before its fence B.
  const seenAt = new Date(Date.now() + 3_600_000);
  const capabilities = [...SERVER_CAPABILITIES];
  await prisma.serverHeartbeat.upsert({
    where: { instanceId: serverInstance },
    create: { instanceId: serverInstance, capabilities, seenAt },
    update: { seenAt },
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await prisma.serverHeartbeat.deleteMany({ where: { instanceId: serverInstance } });
  await f.cleanup();
}, slowStore(60_000));
afterAll(() => closeProjectLocks());

/** 150 expired and 150 retained events sharing actors, tenants, targets and an attribute; one attribute only expires. */
async function seed() {
  const now = Date.now();
  const rows = Array.from({ length: 300 }, (_, i) => {
    const expired = i < 150;
    const at = expired ? now - (40 + (i % 20)) * DAY : now - (i % 20) * DAY - 60_000;
    return f.row({
      id: `seed-${i}`,
      action: 'qa.retention',
      actor: { id: `a${i % 10}`, name: `Actor ${i % 10}` },
      tenant: { id: `t${i % 3}` },
      targets: [{ type: 'page', id: `p${i % 5}` }],
      plan: `plan-${i % 2}`,
      ...(expired ? { legacyFlag: 'old' } : {}),
      occurredAt: new Date(at).toISOString(),
    });
  });
  await insertEvents(clickhouse, rows);
}

const liveEvent = (i: number) => ({
  id: `live-${i}`,
  action: 'qa.live',
  actor: { id: `a${i % 10}`, name: `Actor ${i % 10}` },
  tenant: { id: `t${i % 3}` },
  targets: [{ type: 'page', id: `p${i % 5}` }],
  plan: `plan-${i % 2}`,
  occurredAt: new Date(Date.now() - (i % 5) * DAY).toISOString(),
});

type Row = Record<string, string | number>;
const settings = (plain: boolean) => (plain ? CLICKHOUSE_PLAIN_READ : {});
async function rows(query: string, plain = false) {
  return (await (
    await clickhouse.query({ query, query_params: { p: f.project }, format: 'JSONEachRow', clickhouse_settings: settings(plain) })
  ).json()) as Row[];
}
/** Rollups as readers are served them, and as recomputed from the raw rows readers see. */
async function rollupsAgainstRaw(plain = false) {
  const [truthEntities, servedEntities, truthKeys, servedKeys, truthTotal, servedTotal] = await Promise.all([
    rows(
      `SELECT kind, entity_id, toUInt64(sum(n)) events, min(f) first_seen, max(l) last_seen FROM (
        SELECT 'actor' kind, actor_id entity_id, count() n, min(timestamp) f, max(timestamp) l FROM events WHERE project_id={p:String} AND actor_id!='' GROUP BY entity_id
        UNION ALL SELECT 'tenant', tenant_id, count(), min(timestamp), max(timestamp) FROM events WHERE project_id={p:String} AND tenant_id!='' GROUP BY tenant_id
        UNION ALL SELECT 'target', concat(t.1,':',t.2) e, count(), min(timestamp), max(timestamp) FROM events ARRAY JOIN arrayZip(target_types,target_ids) AS t WHERE project_id={p:String} GROUP BY e
      ) GROUP BY kind, entity_id ORDER BY kind, entity_id`,
      plain,
    ),
    rows(
      "SELECT kind, entity_id, toUInt64(sum(events)) events, min(first_seen) first_seen, max(last_seen) last_seen FROM entities WHERE project_id={p:String} AND kind IN ('actor','tenant','target') GROUP BY kind, entity_id HAVING events > 0 ORDER BY kind, entity_id",
      plain,
    ),
    rows(
      'SELECT k key, toUInt64(count()) count, max(timestamp) last_seen FROM events ARRAY JOIN mapKeys(attributes) AS k WHERE project_id={p:String} GROUP BY k ORDER BY k',
      plain,
    ),
    rows(
      'SELECT key, toUInt64(sum(count)) count, max(last_seen) last_seen FROM attribute_keys WHERE project_id={p:String} GROUP BY key HAVING count > 0 ORDER BY key',
      plain,
    ),
    rows('SELECT toUInt64(count()) n FROM events WHERE project_id={p:String}', plain),
    rows('SELECT toUInt64(sum(events)) n FROM events_by_minute WHERE project_id={p:String}', plain),
  ]);
  return {
    entities: { truth: truthEntities, served: servedEntities },
    attributeKeys: { truth: truthKeys, served: servedKeys },
    minuteTotal: { truth: Number(truthTotal[0]?.n), served: Number(servedTotal[0]?.n ?? 0) },
  };
}
async function expectRollupsExact(label: string, plain = false) {
  const r = await rollupsAgainstRaw(plain);
  expect(r.entities.served, `${label}: entities`).toEqual(r.entities.truth);
  expect(r.attributeKeys.served, `${label}: attribute keys`).toEqual(r.attributeKeys.truth);
  expect(r.minuteTotal.served, `${label}: events by minute`).toBe(r.minuteTotal.truth);
  return r;
}
const expiredVisible = async (plain = false) =>
  Number((await rows('SELECT count() n FROM events WHERE project_id={p:String} AND timestamp < now64(3) - INTERVAL 30 DAY', plain))[0]?.n ?? 0);
async function untilMaterialized() {
  const deadline = Date.now() + slowStore(120_000);
  while ((await pendingProjectMutations(maintenanceClickhouse, f.project)).length) {
    if (Date.now() > deadline) throw new Error('Retention DELETEs did not finish');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  expect(await withProjectLock(f.project, () => reconcileDestructiveMaintenance(f.project))).toBe(true);
}
const latestRun = () => prisma.retentionRun.findFirstOrThrow({ where: { projectId: f.project, kind: 'retention' }, orderBy: { startedAt: 'desc' } });

/** Live ingest into the same project and keys, plus a shared-lock probe measuring how long ingest would wait. */
function liveTraffic() {
  // Bound to this test's fixture: a loop left running must never write into the next test's project.
  const fixture = f;
  let running = true;
  let paused = false;
  let idle: (() => void) | undefined;
  let next = 0;
  const statuses: number[] = [];
  const ingestMs: number[] = [];
  const lockWaitMs: number[] = [];
  let busy = 0;
  const ids: string[] = [];
  const ingest = (async () => {
    while (running) {
      if (paused) {
        idle?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      const event = liveEvent(next++);
      const t = performance.now();
      const response = await fixture.post(event);
      ingestMs.push(performance.now() - t);
      statuses.push(response.status);
      if (response.status === 202) ids.push(event.id);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  const probe = (async () => {
    while (running) {
      const t = performance.now();
      try {
        await withProjectLock(fixture.project, async () => undefined, { mode: 'shared', waitMs: 3000 });
      } catch (error) {
        if (error instanceof ProjectBusyError) busy++;
        else throw error;
      }
      lockWaitMs.push(performance.now() - t);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  return {
    ids,
    /** Ingest paused for a consistent snapshot (the probe keeps measuring). */
    async quiet<T>(work: () => Promise<T>) {
      paused = true;
      await new Promise<void>((resolve) => {
        idle = resolve;
      });
      try {
        return await work();
      } finally {
        paused = false;
        idle = undefined;
      }
    },
    async stop() {
      running = false;
      paused = false;
      await Promise.all([ingest, probe]);
      return { statuses, ingestMaxMs: Math.max(...ingestMs), lockWaitMaxMs: Math.max(...lockWaitMs), busy, probes: lockWaitMs.length };
    },
  };
}

it('deletes in the background: ingest waits only for the fences, and rollups match the raw rows at every phase', purgeLimit(180_000), async () => {
  await f.authorize();
  await seed();
  await expectRollupsExact('before');
  const traffic = liveTraffic();
  let measured: Awaited<ReturnType<typeof traffic.stop>> | undefined;
  try {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const outcome = await runBackgroundRetention(f.project, {
      // Staged, nothing visible changed yet: the old rollups still match the raw rows, expired rows included.
      betweenFences: async () => {
        await traffic.quiet(() => expectRollupsExact('between the fences'));
      },
    });
    expect(outcome).toBe('materializing');
    const run = await latestRun();
    expect(run).toMatchObject({ status: 'materializing', deletedEvents: 150, error: null });
    // The DELETEs are still being applied in ClickHouse: readers see them applied already.
    expect((await pendingProjectMutations(maintenanceClickhouse, f.project)).length).toBeGreaterThan(0);
    await traffic.quiet(async () => {
      expect(await expiredVisible()).toBe(0);
      await expectRollupsExact('after the second fence, deletes pending');
    });
    // An export now says retention is finishing, with when to retry (not a timer or a generic busy error).
    const refused = await f.management(`/api/projects/${f.project}/export?format=jsonl&from=${new Date(Date.now() - 365 * DAY).toISOString()}`);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('Retry-After')).toBe('60');
    expect((await refused.json()).error).toMatchObject({
      code: 'export_project_unreadable',
      message: expect.stringContaining('Retention is finishing'),
    });
    await untilMaterialized();
    expect(await latestRun()).toMatchObject({ status: 'completed', deletedEvents: 150, error: null });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: f.project } })).exportDeleteStartedAt).toBeNull();
    await traffic.quiet(async () => {
      await expectRollupsExact('after completion');
      // The stored parts themselves, not only what readers are shown.
      expect(await expiredVisible(true)).toBe(0);
      await expectRollupsExact('after completion, plain reads', true);
    });
    measured = await traffic.stop();
  } finally {
    measured ??= await traffic.stop();
  }
  const final = await expectRollupsExact('final');
  // Every live write survived: nothing that arrived inside the window was deleted.
  expect(final.minuteTotal.truth).toBe(150 + traffic.ids.length);
  const stored = await read<{ id: string }>(
    clickhouse,
    "SELECT event_id id FROM events WHERE project_id={p:String} AND startsWith(event_id, 'live-')",
    {
      p: f.project,
    },
  );
  expect(stored.map((r) => r.id).sort()).toEqual([...traffic.ids].sort());
  expect(measured.statuses.every((s) => s === 202)).toBe(true);
  expect(measured.busy).toBe(0);
  expect(measured.lockWaitMaxMs).toBeLessThan(3000);
  // Opt-in evidence for reviews: where the measured waits are written (vitest hides console output here).
  if (process.env.LOGBIRD_QA_MEASURE_OUT)
    appendFileSync(
      process.env.LOGBIRD_QA_MEASURE_OUT,
      `${JSON.stringify({ event: 'qa.retention_background', live: traffic.ids.length, ...measured })}
`,
    );
});

it('cancels the run and deletes nothing when the retention period changes between the fences', purgeLimit(90_000), async () => {
  await seed();
  const outcome = await runBackgroundRetention(f.project, {
    betweenFences: async () => {
      await prisma.project.update({ where: { id: f.project }, data: { retentionDays: 90 } });
    },
  });
  expect(outcome).toBe('canceled');
  expect(await latestRun()).toMatchObject({ status: 'canceled', error: expect.stringContaining('retention period changed') });
  expect(await pendingProjectMutations(maintenanceClickhouse, f.project)).toEqual([]);
  expect(await f.count()).toBe(300);
  expect((await prisma.project.findUniqueOrThrow({ where: { id: f.project } })).exportDeleteStartedAt).toBeNull();
  await expectRollupsExact('after a canceled run');
});

it('cancels the run when a recovered write with its original receive clock lands between the fences', purgeLimit(120_000), async () => {
  await seed();
  const recovered = liveEvent(9000);
  const outcome = await runBackgroundRetention(f.project, {
    betweenFences: async () => {
      // An abandoned claim from before the run, retried now: recovery replays it with its original receive clock.
      await f.pending(recovered, { expired: true, receivedAt: new Date(Date.now() - 120_000) });
      expect((await f.post(recovered)).status).toBe(202);
    },
  });
  expect(outcome).toBe('canceled');
  expect(await latestRun()).toMatchObject({ status: 'canceled', error: expect.stringContaining('Recovered writes') });
  expect(await pendingProjectMutations(maintenanceClickhouse, f.project)).toEqual([]);
  expect(await f.count()).toBe(301);
  await expectRollupsExact('after a recovered write canceled the run');
});

it('fences rollup reads until retention rebuilds them when the run dies right after its DELETEs exist', purgeLimit(240_000), async () => {
  await seed();
  await expect(
    runBackgroundRetention(f.project, {
      afterDeletes: async () => {
        throw new Error('QA crash after the DELETEs');
      },
    }),
  ).rejects.toThrow('QA crash');
  expect(await latestRun()).toMatchObject({ status: 'failed' });
  expect(await prisma.retentionRun.count({ where: { projectId: f.project, kind: 'ingest_repair', status: 'failed' } })).toBe(1);
  // Rollup reads are refused rather than served from rollups missing their replacement rows.
  await expect(beginRollupRead(f.project)).rejects.toMatchObject({ code: 'retention_unavailable' });
  // Ingest is not refused.
  expect((await f.post(liveEvent(1))).status).toBe(202);
  await untilMaterialized();
  // The next hourly run repairs on the synchronous path.
  expect(await runBackgroundRetention(f.project)).toBe('synchronous');
  expect(await prisma.retentionRun.count({ where: { projectId: f.project, kind: 'ingest_repair', status: { in: ['running', 'failed'] } } })).toBe(0);
  expect(await beginRollupRead(f.project)).toBeTypeOf('bigint');
  expect(await expiredVisible(true)).toBe(0);
  await expectRollupsExact('after the repair');
});

it('cannot be moved by an app instance clock: fences use the database clock, and claims get a skew allowance', purgeLimit(180_000), async () => {
  await seed();
  const lagging: string[] = [];
  const outcome = await runBackgroundRetention(f.project, {
    betweenFences: async () => {
      // An instance whose clock lags 20 s writes between the fences: its rows are stamped with the database clock.
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 20_000 });
      try {
        for (let i = 0; i < 5; i++) {
          const event = { ...liveEvent(500 + i), occurredAt: new Date(Date.now() + 20_000 - 45 * DAY).toISOString() };
          expect((await f.post(event)).status).toBe(202);
          lagging.push(event.id);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  });
  expect(outcome).toBe('materializing');
  await untilMaterialized();
  // They are older than the cutoff, but arrived after the first fence: this run kept them (the next deletes them).
  const kept = await read<{ id: string }>(
    clickhouse,
    'SELECT event_id id FROM events WHERE project_id={p:String} AND event_id IN {ids:Array(String)}',
    {
      p: f.project,
      ids: lagging,
    },
  );
  expect(kept.map((r) => r.id).sort()).toEqual([...lagging].sort());
  await expectRollupsExact('after a lagging instance wrote between the fences');
  // An unresolved claim that looks settled by lease and flush bound alone (80 s old) is still inside the allowance.
  expect(RETENTION_CLOCK_SKEW_ALLOWANCE_MS).toBeGreaterThan(10_000);
  await f.pending({ id: 'in-flight', action: 'qa.claim' }, { expired: true });
  await prisma.project.update({ where: { id: f.project }, data: { retentionDays: 1 } });
  const before = await prisma.retentionRun.count({ where: { projectId: f.project } });
  expect(await runBackgroundRetention(f.project)).toBe('deferred');
  expect(await prisma.retentionRun.count({ where: { projectId: f.project } })).toBe(before);
});

/** Kills this project's pending mutations on `events` by id (a held mutation must never stay on the shared table). */
async function killHeld(project: string) {
  for (const m of await pendingProjectMutations(maintenanceClickhouse, project))
    if (m.table === 'events')
      await maintenanceClickhouse.command({
        // Mutation ids are per table: bind the database, the table and the id (#268).
        query: 'KILL MUTATION WHERE database = currentDatabase() AND table = {table:String} AND mutation_id = {id:String} SYNC',
        query_params: { table: m.table, id: m.mutationId },
      });
}
/**
 * A hard ceiling on a held mutation (RULES, shared store): after `ms` it is killed by id whatever the assertions are
 * doing, so a held mutation that went wrong never sits on the shared `events` table waiting for a `finally`.
 */
function holdCeiling(project: string, ms = 90_000) {
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    void killHeld(project);
  }, ms);
  return {
    get fired() {
      return fired;
    },
    clear: () => clearTimeout(timer),
  };
}
/** Whether this exact mutation is still pending (checked at the end of each held-mutation test). */
async function stillPending(table: string, mutationId: string) {
  const [row] = await maintenanceClickhouse
    .query({
      query:
        'SELECT count() n FROM system.mutations WHERE database = currentDatabase() AND table = {table:String} AND mutation_id = {id:String} AND is_done = 0',
      query_params: { table, id: mutationId },
      format: 'JSONEachRow',
    })
    .then((r) => r.json<{ n: string }>());
  return Number(row?.n ?? 0) > 0;
}

it(
  'never refuses ingest while a foreign mutation that cannot be applied on the fly is pending; reads say so and readiness holds',
  purgeLimit(180_000),
  async () => {
    await f.authorize();
    const foreign = `${f.project}-foreign`;
    // 8,000 rows sleeping 0.35 ms each: at most 2.8 s even if every one of them lands in one block, whatever block size
    // the store applies mutations in (30,000 rows was seen), so the held mutation stays under ClickHouse's 3 s
    // background sleep cap and never fails and retries. The DELETE's normal pass over the table's parts keeps it pending
    // for the assertions. Fewer than 10,000 rows, so this fixture is not a load run by itself.
    await insertEvents(
      clickhouse,
      Array.from({ length: 8000 }, (_, k) =>
        f.row({ id: `foreign-${k}`, action: 'qa.foreign', occurredAt: new Date(Date.now() - DAY).toISOString() }),
      ).map((row) => ({ ...row, project_id: foreign })),
    );
    let heldId: string | undefined;
    let ceiling: ReturnType<typeof holdCeiling> | undefined;
    try {
      // An operator's mutation with now() in its predicate, created without Logbird's initiator settings.
      await maintenanceClickhouse.command({
        query:
          'ALTER TABLE events DELETE WHERE project_id = {fp:String} AND timestamp < now() AND if(project_id = {fp:String}, sleepEachRow(0.00035), 0) = 0',
        query_params: { fp: foreign },
        clickhouse_settings: {
          mutations_sync: '0',
          allow_nondeterministic_mutations: 1,
          short_circuit_function_evaluation: 'force_enable',
          mutations_execute_nondeterministic_on_initiator: 0,
          mutations_execute_subqueries_on_initiator: 0,
        } as never,
      });
      const [held] = await pendingProjectMutations(maintenanceClickhouse, foreign);
      expect(held).toBeDefined();
      heldId = held?.mutationId;
      ceiling = holdCeiling(foreign);
      // Ingest is never refused: a new event and an exact retry (which goes through the identity lookups) both land.
      const event = liveEvent(7000);
      expect((await f.post(event)).status).toBe(202);
      expect((await f.post(event)).status).toBe(202);
      // A console read refuses clearly and retryably, never a 500 and never a plain-read fallback.
      const blocked = await f.management(`/api/projects/${f.project}/events?from=${new Date(Date.now() - 7 * DAY).toISOString()}`);
      expect(blocked.status).toBe(503);
      expect(blocked.headers.get('Retry-After')).toBe('30');
      expect((await blocked.json()).error).toMatchObject({
        code: 'store_maintenance_blocking',
        message: expect.stringContaining('maintenance operation on the event store is blocking reads'),
      });
      // Readiness does not flip.
      expect((await f.management('/readyz')).status).toBe(200);
      expect((await pendingProjectMutations(maintenanceClickhouse, foreign)).length).toBe(1);
      while ((await pendingProjectMutations(maintenanceClickhouse, foreign)).length) {
        if (ceiling.fired) throw new Error('The held foreign mutation passed its 90 s ceiling and was killed by id');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (ceiling.fired) throw new Error('The held foreign mutation passed its 90 s ceiling and was killed by id');
      const recovered = await f.management(`/api/projects/${f.project}/events?from=${new Date(Date.now() - 7 * DAY).toISOString()}`);
      expect(recovered.status).toBe(200);
      expect((await recovered.json()).data.map((e: { id: string }) => e.id)).toContain(event.id);
    } finally {
      // Never leave the held mutation behind, even when an assertion failed: it would hold other mutations on its part.
      ceiling?.clear();
      await killHeld(foreign);
      if (heldId) expect(await stillPending('events', heldId)).toBe(false);
      for (const table of ['events', 'event_ids', 'events_by_minute', 'entities', 'attribute_keys'])
        await maintenanceClickhouse.command({
          query: `DELETE FROM ${table} WHERE project_id = {fp:String}`,
          query_params: { fp: foreign },
          clickhouse_settings: { mutations_sync: '2', lightweight_deletes_sync: '2' } as never,
        });
    }
  },
);

it(
  'answers store_maintenance_blocking when a pending foreign mutation is applied on the fly but its predicate fails the read',
  purgeLimit(180_000),
  async () => {
    await f.authorize();
    // An operator's mutation on this project's own rows whose predicate errors when applied: 20,000 rows sleeping 0.3 ms
    // each exceed ClickHouse's 3 s sleep cap in one block, so a read that reaches them fails, which is the case readers
    // must report clearly. The background mutation fails and retries in the same way (the store applies mutations in
    // blocks of about 30,000 rows), so the hold is bounded by a 90 s ceiling and killed by id in `finally`.
    await insertEvents(
      clickhouse,
      Array.from({ length: 20_000 }, (_, i) => f.row({ id: `held-${i}`, action: 'qa.held', occurredAt: new Date(Date.now() - DAY).toISOString() })),
    );
    let heldId: string | undefined;
    let ceiling: ReturnType<typeof holdCeiling> | undefined;
    try {
      await maintenanceClickhouse.command({
        query:
          "ALTER TABLE events DELETE WHERE project_id = {p:String} AND action = 'qa.held' AND if(project_id = {p:String}, sleepEachRow(0.0003), 0) = 0",
        query_params: { p: f.project },
        clickhouse_settings: { mutations_sync: '0', allow_nondeterministic_mutations: 1, short_circuit_function_evaluation: 'force_enable' } as never,
      });
      const [held] = await pendingProjectMutations(maintenanceClickhouse, f.project);
      expect(held).toBeDefined();
      heldId = held?.mutationId;
      ceiling = holdCeiling(f.project);
      // The read fails because the predicate errors when applied, not because the mutation cannot be applied on the fly.
      const direct = await clickhouse
        .query({ query: 'SELECT count() n FROM events WHERE project_id={p:String}', query_params: { p: f.project }, format: 'JSONEachRow' })
        .then((r) => r.json())
        .then(
          () => '',
          (error: Error) => error.message,
        );
      expect(direct).toMatch(/maximum sleep time/i);
      expect(direct).not.toMatch(/cannot be applied on fly/);
      // Ingest is not refused (its identity lookups read plain).
      expect((await f.post(liveEvent(8000))).status).toBe(202);
      // The console read reaching those rows answers clearly and retryably, never a 500.
      const blocked = await f.management(`/api/projects/${f.project}/events?from=${new Date(Date.now() - 7 * DAY).toISOString()}`);
      expect(blocked.status).toBe(503);
      expect(blocked.headers.get('Retry-After')).toBe('30');
      expect((await blocked.json()).error.code).toBe('store_maintenance_blocking');
      expect((await f.management('/readyz')).status).toBe(200);
      if (ceiling.fired) throw new Error('The held mutation passed its 90 s ceiling and was killed by id');
    } finally {
      // Never leave the held mutation behind, even when an assertion failed.
      ceiling?.clear();
      await killHeld(f.project);
      if (heldId) expect(await stillPending('events', heldId)).toBe(false);
    }
  },
);
