// Discovery cost with and without the webhook delivery window (#152), for its review. Needs SCRATCH databases: Postgres
// (DATABASE_URL) and ClickHouse (CLICKHOUSE_DATABASE), both migrated from this branch. It is a load run (100,000 events by default; BENCH_EVENTS and BENCH_SPREAD_DAYS change that).
//   node --env-file=.env --import tsx scripts/bench-discovery-window.ts
// A historical import (by default 100,000 events whose occurrence times spread over a year), all arriving within minutes. Then,
// for 1, 10 and 100 endpoints, the discovery cost to scan through the import with no window (today's scan) and with the
// 7-day default: usually one scan query per endpoint (a scan covers at most five minutes of arrivals, so a slow import
// takes more). The endpoints' filter matches nothing, so the numbers are the scan itself, not queuing deliveries.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type ClickHouseClient, createMaintenanceClickHouseClient, insertEvents, normalizeEvent, read } from '@logbird/clickhouse';
import { DEFAULT_WEBHOOK_DELIVERY_WINDOW_SECONDS } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { webhookCursorClock } from '@logbird/database/webhooks';
import { discoverWebhookDeliveries } from '../apps/worker/src/webhook-discovery';
import { webhookWatermark } from '../apps/worker/src/webhook-policy';

const SCRATCH = /^logbird_t2_scratch_/;
const ch = createMaintenanceClickHouseClient();
// Check the databases the connections actually use (a URL path can override CLICKHOUSE_DATABASE) before writing anything.
const [chDatabase] = await read<{ db: string }>(ch, 'SELECT currentDatabase() db');
const [pgDatabase] = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
for (const name of [chDatabase?.db, pgDatabase?.db])
  if (!SCRATCH.test(name ?? '')) throw new Error(`Refusing to run outside scratch databases (${name})`);
const projectId = `bench-discovery-${randomUUID()}`;
// Size and occurrence spread are configurable: a 1M-event ten-year import needs more than the shared dev server's 1.79 GiB
// (#353), so the default is 100,000 events over one year (about 12 monthly partitions instead of 120).
const positive = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!(Number.isSafeInteger(value) && value > 0)) throw new Error(`${name} must be a positive integer`);
  return value;
};
const TOTAL = positive('BENCH_EVENTS', 100_000);
const SPREAD_DAYS = positive('BENCH_SPREAD_DAYS', 365);
const BATCH = 10_000;
const SPREAD = SPREAD_DAYS * 86_400_000;

/** Tags every read with a query_id containing `tag`, so the query log attributes each scan to its case alone. */
function tagged(client: ClickHouseClient, tag: string): ClickHouseClient {
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property !== 'query') return value.bind(target);
      return (params: { query_id?: string } & Record<string, unknown>) =>
        value.call(target, { ...params, query_id: `${params?.query_id ?? ''}${tag}-${randomUUID()}` });
    },
  });
}

async function memoryMiB() {
  const [row] = await read<{ v: string }>(ch, "SELECT value v FROM system.metrics WHERE metric = 'MemoryTracking'");
  return Number(row?.v ?? 0) / 2 ** 20;
}

await prisma.organization.create({ data: { id: projectId, name: projectId, slug: projectId, createdAt: new Date() } });
await prisma.project.create({ data: { id: projectId, organizationId: projectId, name: projectId, slug: projectId } });
const { now: start } = await webhookCursorClock(prisma);
const importStarted = performance.now();
let lastReceivedAt = start;
for (let offset = 0; offset < TOTAL; offset += BATCH) {
  // Keep the shared server's memory clear of its limit while merges catch up.
  while ((await memoryMiB()) > 1100) await delay(2000);
  // Arrival times come from the same (Postgres) clock as the endpoints' cursors, so no batch can fall before them.
  const { now: receivedAt } = await webhookCursorClock(prisma);
  if (receivedAt < start) throw new Error('Postgres clock went backwards');
  lastReceivedAt = receivedAt;
  await insertEvents(
    ch,
    Array.from({ length: Math.min(BATCH, TOTAL - offset) }, (_, i) => {
      const index = offset + i;
      const normalized = normalizeEvent(
        { id: `import-${index}`, action: 'import.record', occurredAt: new Date(+receivedAt - Math.floor((index / TOTAL) * SPREAD)).toISOString() },
        { projectId, receivedAt },
      );
      if (!normalized.ok) throw new Error(normalized.reason);
      return normalized.row;
    }),
  );
}
const importSeconds = (performance.now() - importStarted) / 1000;
// Discovery scans only up to its watermark, which trails the clock by the async-insert flush bound and a margin. Until
// the watermark passes the import, a pass reads nothing; wait for it (one second of slack between the two clocks).
while (+webhookWatermark((await webhookCursorClock(prisma)).now, null) <= +lastReceivedAt + 1000) await delay(1000);

const results: {
  endpoints: number;
  window: number | null;
  passMs: number;
  perEndpointMs: number;
  passes: number;
  scanQueries: number;
  readRows: number;
  readBytes: number;
}[] = [];
for (const endpoints of [1, 10, 100])
  for (const window of [null, DEFAULT_WEBHOOK_DELIVERY_WINDOW_SECONDS]) {
    const hooks = await Promise.all(
      Array.from({ length: endpoints }, () =>
        prisma.webhookEndpoint.create({
          data: {
            projectId,
            url: 'https://fixture.example.invalid',
            createdAt: start,
            cursorReceivedAt: start,
            filterQuery: 'action:bench.never',
            deliveryWindowSeconds: window,
          },
        }),
      ),
    );
    // Every scan of this case carries the case's tag in its query_id: concurrent runs and earlier cases cannot count here.
    const tag = `bench-discovery-${randomUUID()}`;
    const scanner = tagged(ch, tag);
    const clock = await webhookCursorClock(prisma);
    const started = performance.now();
    let passes = 0;
    for (const hook of hooks) {
      // Each endpoint scans, as passes would, until its cursor is past the import, and at least once. A scan that never
      // reaches the import measured nothing, so the bench fails rather than report it.
      for (let pass = 0; ; pass++) {
        const current = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } });
        if (pass > 0 && +current.cursorReceivedAt > +lastReceivedAt) break;
        if (pass === 100) throw new Error(`Endpoint ${hook.id} did not scan past the import in 100 passes`);
        await discoverWebhookDeliveries(scanner, current, { now: clock.now, rollout: new Date(+start - 1) });
        passes++;
      }
    }
    const passMs = performance.now() - started;
    await ch.command({ query: 'SYSTEM FLUSH LOGS' });
    const [usage] = await read<{ queries: string; rows: string; bytes: string }>(
      ch,
      `SELECT count() queries, sum(read_rows) rows, sum(read_bytes) bytes FROM system.query_log
        WHERE event_date >= yesterday() AND type = 'QueryFinish' AND position(query_id, {tag:String}) > 0
          AND query LIKE '%SELECT event_id, toUnixTimestamp64Milli(received_at) AS received_ms FROM events%'`,
      { tag },
    );
    // Each pass reaching the import issues exactly one scan: a query log that lacks some (disabled, sampled) is not a measurement.
    if (Number(usage?.queries ?? 0) !== passes) throw new Error(`Query log has ${usage?.queries ?? 0} of ${passes} scans`);
    const result = {
      endpoints,
      window,
      passMs: Math.round(passMs),
      perEndpointMs: Math.round(passMs / endpoints),
      passes,
      scanQueries: Number(usage?.queries ?? 0),
      readRows: Number(usage?.rows ?? 0),
      readBytes: Number(usage?.bytes ?? 0),
    };
    console.log(JSON.stringify({ result }));
    results.push(result);
    await prisma.webhookEndpoint.deleteMany({ where: { id: { in: hooks.map(({ id }) => id) } } });
  }
console.log(JSON.stringify({ import: { events: TOTAL, spreadDays: SPREAD_DAYS, seconds: Math.round(importSeconds) }, results }, null, 2));
await prisma.organization.deleteMany({ where: { id: projectId } });
await Promise.all([ch.close(), prisma.$disconnect()]);
