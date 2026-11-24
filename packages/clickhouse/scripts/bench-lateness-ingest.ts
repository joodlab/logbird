// Ingest cost of the webhook lateness rollup (migration 011), for its review. Run against a SCRATCH ClickHouse database
// (CLICKHOUSE_DATABASE) that has every migration applied: it drops and recreates events_lateness_mv there.
//   node --import tsx packages/clickhouse/scripts/bench-lateness-ingest.ts
// 1. Throughput: 50,000 events per round in batches of 500 (the .NET 50,000-event load test's batch size), shaped like
//    that test's events, alternating rounds without and with the view.
// 2. Size: 100,000 events whose occurrence times spread over ten years, all arriving in one hour (a historical import).
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

async function round(withView: boolean) {
  await ch.command({ query: 'DROP VIEW IF EXISTS events_lateness_mv' });
  if (withView) await ch.command({ query: createView });
  const projectId = `bench-lateness-${randomUUID()}`;
  const started = performance.now();
  for (let offset = 0; offset < PER_ROUND; offset += BATCH) {
    const receivedAt = new Date();
    await insertEvents(
      ch,
      Array.from({ length: BATCH }, (_, i) => event(projectId, offset + i, receivedAt, receivedAt)),
    );
  }
  const seconds = (performance.now() - started) / 1000;
  return { withView, events: PER_ROUND, seconds: Number(seconds.toFixed(2)), eventsPerSecond: Math.round(PER_ROUND / seconds) };
}

const rounds: Awaited<ReturnType<typeof round>>[] = [];
for (const withView of [false, true, false, true, false, true]) rounds.push(await round(withView));
const average = (view: boolean) => {
  const picked = rounds.filter((r) => r.withView === view);
  return Math.round(picked.reduce((sum, r) => sum + r.eventsPerSecond, 0) / picked.length);
};

// Size: a ten-year historical import arriving within one hour, with the view in place.
const importProject = `bench-lateness-import-${randomUUID()}`;
const arrival = new Date();
const span = 3650 * 86_400_000;
for (let offset = 0; offset < 100_000; offset += BATCH)
  await insertEvents(
    ch,
    Array.from({ length: BATCH }, (_, i) => {
      const index = offset + i;
      return event(importProject, index, arrival, new Date(+arrival - Math.floor((index / 100_000) * span)));
    }),
  );
await ch.command({ query: 'OPTIMIZE TABLE events_lateness_by_hour FINAL' });
const [size] = await read<{ rows: string; bytes: string; uncompressed: string }>(
  ch,
  `SELECT sum(rows) rows, sum(bytes_on_disk) bytes, sum(data_uncompressed_bytes) uncompressed FROM system.parts
    WHERE database = currentDatabase() AND table = 'events_lateness_by_hour' AND active`,
);
const [importRows] = await read<{ n: string; hours: string }>(
  ch,
  'SELECT count() n, uniqExact(late_hours) hours FROM events_lateness_by_hour FINAL WHERE project_id = {p:String}',
  { p: importProject },
);
console.log(
  JSON.stringify(
    {
      database,
      rounds,
      averageEventsPerSecond: { withoutView: average(false), withView: average(true) },
      historicalImport: { events: 100_000, rollupRows: Number(importRows?.n), distinctLateHours: Number(importRows?.hours) },
      rollupTable: { rows: Number(size?.rows), bytesOnDisk: Number(size?.bytes), uncompressedBytes: Number(size?.uncompressed) },
    },
    null,
    2,
  ),
);
await ch.close();
