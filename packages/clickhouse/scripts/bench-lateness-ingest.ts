// Ingest cost of the webhook lateness rollup (migration 011), for its review. Run against a SCRATCH ClickHouse database
// (CLICKHOUSE_DATABASE) that has every migration applied: it drops and recreates events_lateness_mv there.
//   node --import tsx packages/clickhouse/scripts/bench-lateness-ingest.ts
// 1. On-time throughput: five pairs of rounds, without and with the view, 50,000 events per round in batches of 500 (the
//    .NET 50,000-event load test's batch size), shaped like that test's events. For each round with the view, the parts
//    written to the rollup table (system.part_log): an on-time block should write none.
// 2. Late-heavy throughput: three pairs of rounds whose occurrence times spread over ten years.
// 3. Size: 100,000 events whose occurrence times spread over ten years, all arriving in one hour (a historical import).
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMaintenanceClickHouseClient, insertEvents } from '../src/client';
import { normalizeEvent } from '../src/normalize';
import { read } from '../src/queries';

const database = process.env.CLICKHOUSE_DATABASE ?? '';
if (!/^logbird_t2_scratch_/.test(database)) throw new Error(`Refusing to run outside a scratch database (CLICKHOUSE_DATABASE=${database})`);
const ch = createMaintenanceClickHouseClient();
const migration = await readFile(new URL('../migrations/011_events_lateness.sql', import.meta.url), 'utf8');
const createView = migration.slice(migration.indexOf('CREATE MATERIALIZED VIEW')).trim();
const PER_ROUND = 50_000;
const BATCH = 500;
const TEN_YEARS = 3650 * 86_400_000;

function event(projectId: string, index: number, receivedAt: Date, occurredAt: Date) {
  const normalized = normalizeEvent(
    {
      id: `bench-${index}`,
      action: 'load.checked',
      occurredAt: occurredAt.toISOString(),
      actor: { type: 'user', id: `user_${index % 100}` },
      tenant: { id: `acct_${index % 10}` },
      targets: [{ type: 'record', id: `rec_${index}` }],
      changes: [{ field: 'status', from: 'draft', to: 'sent' }],
      context: { operationId: `op_${projectId}` },
      metadata: { n: index },
    },
    { projectId, receivedAt },
  );
  if (!normalized.ok) throw new Error(normalized.reason);
  return normalized.row;
}

async function rollupParts(from: Date, to: Date) {
  await ch.command({ query: 'SYSTEM FLUSH LOGS' });
  const [row] = await read<{ n: string }>(
    ch,
    `SELECT count() n FROM system.part_log WHERE database = currentDatabase() AND table = 'events_lateness_by_hour'
      AND event_type = 'NewPart' AND event_time_microseconds >= {a:DateTime64(6,'UTC')} AND event_time_microseconds <= {b:DateTime64(6,'UTC')}`,
    { a: from.toISOString().replace('T', ' ').slice(0, -1), b: to.toISOString().replace('T', ' ').slice(0, -1) },
  );
  return Number(row?.n ?? 0);
}

async function round(withView: boolean, late: boolean) {
  await ch.command({ query: 'DROP VIEW IF EXISTS events_lateness_mv' });
  if (withView) await ch.command({ query: createView });
  const projectId = `bench-lateness-${randomUUID()}`;
  const startedAt = new Date();
  const started = performance.now();
  for (let offset = 0; offset < PER_ROUND; offset += BATCH) {
    const receivedAt = new Date();
    await insertEvents(
      ch,
      Array.from({ length: BATCH }, (_, i) => {
        const index = offset + i;
        const occurredAt = late ? new Date(+receivedAt - Math.floor(((index % 997) / 997) * TEN_YEARS) - 2 * 3_600_000) : receivedAt;
        return event(projectId, index, receivedAt, occurredAt);
      }),
    );
  }
  const seconds = (performance.now() - started) / 1000;
  const parts = withView ? await rollupParts(startedAt, new Date()) : null;
  return {
    withView,
    late,
    events: PER_ROUND,
    seconds: Number(seconds.toFixed(2)),
    eventsPerSecond: Math.round(PER_ROUND / seconds),
    rollupPartsWritten: parts,
  };
}

type Round = Awaited<ReturnType<typeof round>>;
const rounds: Round[] = [];
for (let pair = 0; pair < 5; pair++) for (const withView of [false, true]) rounds.push(await round(withView, false));
for (let pair = 0; pair < 3; pair++) for (const withView of [false, true]) rounds.push(await round(withView, true));
const summary = (late: boolean) => {
  const picked = rounds.filter((r) => r.late === late);
  const pairs: { without: number; with: number; change: string }[] = [];
  for (let i = 0; i + 1 < picked.length; i += 2) {
    const [without, withView] = [picked[i], picked[i + 1]];
    if (without && withView)
      pairs.push({
        without: without.eventsPerSecond,
        with: withView.eventsPerSecond,
        change: `${(((withView.eventsPerSecond - without.eventsPerSecond) / without.eventsPerSecond) * 100).toFixed(1)}%`,
      });
  }
  const mean = (view: boolean) =>
    Math.round(picked.filter((r) => r.withView === view).reduce((sum, r) => sum + r.eventsPerSecond, 0) / (picked.length / 2));
  return {
    pairs,
    meanWithout: mean(false),
    meanWith: mean(true),
    rollupPartsWritten: picked.filter((r) => r.withView).map((r) => r.rollupPartsWritten),
  };
};

// Size: a ten-year historical import arriving within one hour, with the view in place.
const importProject = `bench-lateness-import-${randomUUID()}`;
const arrival = new Date();
for (let offset = 0; offset < 100_000; offset += BATCH)
  await insertEvents(
    ch,
    Array.from({ length: BATCH }, (_, i) => {
      const index = offset + i;
      return event(importProject, index, arrival, new Date(+arrival - Math.floor((index / 100_000) * TEN_YEARS)));
    }),
  );
await ch.command({ query: 'OPTIMIZE TABLE events_lateness_by_hour FINAL' });
const [importRows] = await read<{ n: string; hours: string }>(
  ch,
  'SELECT count() n, uniqExact(late_hours) hours FROM events_lateness_by_hour FINAL WHERE project_id = {p:String}',
  { p: importProject },
);
const [size] = await read<{ rows: string; bytes: string; uncompressed: string }>(
  ch,
  `SELECT sum(rows) rows, sum(bytes_on_disk) bytes, sum(data_uncompressed_bytes) uncompressed FROM system.parts
    WHERE database = currentDatabase() AND table = 'events_lateness_by_hour' AND active`,
);
console.log(
  JSON.stringify(
    {
      database,
      rounds,
      onTime: summary(false),
      lateHeavy: summary(true),
      historicalImport: { events: 100_000, rollupRows: Number(importRows?.n), distinctLateHours: Number(importRows?.hours) },
      rollupTable: { rows: Number(size?.rows), bytesOnDisk: Number(size?.bytes), uncompressedBytes: Number(size?.uncompressed) },
    },
    null,
    2,
  ),
);
await ch.close();
