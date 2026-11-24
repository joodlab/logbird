// Discovery cost with and without the webhook delivery window (#152), for its review. Needs SCRATCH databases: Postgres
// (DATABASE_URL) and ClickHouse (CLICKHOUSE_DATABASE), both migrated from this branch. It is a load run (100,000 events by default; BENCH_EVENTS and BENCH_SPREAD_DAYS change that).
//   node --env-file=.env --import tsx scripts/bench-discovery-window.ts
// A historical import (by default 100,000 events whose occurrence times spread over a year), all arriving within minutes. Then,
// for 1, 10 and 100 endpoints, one discovery pass over the import with no window (today's scan) and with the 7-day
// default. The endpoints' filter matches nothing, so the numbers are the scan itself, not queuing deliveries.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createMaintenanceClickHouseClient, insertEvents, normalizeEvent, read } from '@logbird/clickhouse';
import { DEFAULT_WEBHOOK_DELIVERY_WINDOW_SECONDS } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { webhookCursorClock } from '@logbird/database/webhooks';
import { discoverWebhookDeliveries } from '../apps/worker/src/webhook-discovery';

const pg = new URL(process.env.DATABASE_URL ?? 'postgres://invalid').pathname.slice(1);
const chDatabase = process.env.CLICKHOUSE_DATABASE ?? '';
for (const name of [pg, chDatabase]) if (!/^logbird_t2_scratch_/.test(name)) throw new Error(`Refusing to run outside scratch databases (${name})`);
const ch = createMaintenanceClickHouseClient();
const projectId = `bench-discovery-${randomUUID()}`;
// Size and occurrence spread are configurable: a 1M-event ten-year import needs more than the shared dev server's 1.79 GiB
// (#353), so the default is 100,000 events over one year (about 12 monthly partitions instead of 120).
const TOTAL = Number(process.env.BENCH_EVENTS ?? 100_000);
const SPREAD_DAYS = Number(process.env.BENCH_SPREAD_DAYS ?? 365);
const BATCH = 10_000;
const SPREAD = SPREAD_DAYS * 86_400_000;

async function memoryMiB() {
  const [row] = await read<{ v: string }>(ch, "SELECT value v FROM system.metrics WHERE metric = 'MemoryTracking'");
  return Number(row?.v ?? 0) / 2 ** 20;
}

await prisma.organization.create({ data: { id: projectId, name: projectId, slug: projectId, createdAt: new Date() } });
await prisma.project.create({ data: { id: projectId, organizationId: projectId, name: projectId, slug: projectId } });
const { now: start } = await webhookCursorClock(prisma);
const importStarted = performance.now();
for (let offset = 0; offset < TOTAL; offset += BATCH) {
  // Keep the shared server's memory clear of its limit while merges catch up.
  while ((await memoryMiB()) > 1100) await delay(2000);
  const receivedAt = new Date();
  await insertEvents(
    ch,
    Array.from({ length: BATCH }, (_, i) => {
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
await delay(5000);

const results: { endpoints: number; window: number | null; passMs: number; perEndpointMs: number; readRows: number; readBytes: number }[] = [];
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
    await ch.command({ query: 'SYSTEM FLUSH LOGS' });
    const before = new Date();
    const clock = await webhookCursorClock(prisma);
    const started = performance.now();
    for (const hook of hooks) {
      // Each endpoint scans until it has caught up with the import, as passes would.
      for (let pass = 0; pass < 10; pass++) {
        const current = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } });
        if (+current.cursorReceivedAt >= +clock.now - 1000) break;
        await discoverWebhookDeliveries(ch, current, { now: clock.now, rollout: new Date(+start - 1) });
      }
    }
    const passMs = performance.now() - started;
    await ch.command({ query: 'SYSTEM FLUSH LOGS' });
    const [usage] = await read<{ rows: string; bytes: string }>(
      ch,
      `SELECT sum(read_rows) rows, sum(read_bytes) bytes FROM system.query_log
        WHERE type = 'QueryFinish' AND event_time_microseconds >= {from:DateTime64(6,'UTC')} AND has(databases, currentDatabase())
          AND query LIKE '%SELECT event_id, toUnixTimestamp64Milli(received_at)%'`,
      { from: before.toISOString().replace('T', ' ').slice(0, -1) },
    );
    const result = {
      endpoints,
      window,
      passMs: Math.round(passMs),
      perEndpointMs: Math.round(passMs / endpoints),
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
