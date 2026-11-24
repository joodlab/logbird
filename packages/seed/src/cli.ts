import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  createClickHouseClient,
  type EventRow,
  facets,
  histogram,
  insertEvents,
  listEntities,
  normalizeEvent,
  overview,
  purgeProject,
  searchEvents,
} from '@logbird/clickhouse';
import type { Prisma } from '@logbird/database';
import { Logbird } from '@logbird/sdk';
import { generateEvents, SEED_PROFILES, type SeedProfile } from './index';

const { values } = parseArgs({
  options: {
    sink: { type: 'string', default: 'api' },
    endpoint: { type: 'string', default: 'http://localhost:4601' },
    key: { type: 'string' },
    'project-id': { type: 'string' },
    project: { type: 'string' },
    profile: { type: 'string', default: 'neutral' },
    until: { type: 'string' },
    events: { type: 'string' },
    days: { type: 'string', default: '60' },
    seed: { type: 'string', default: '42' },
    reset: { type: 'boolean', default: false },
    benchmark: { type: 'boolean', default: false },
  },
});
if (!(values.profile in SEED_PROFILES)) throw new Error(`profile must be one of ${Object.keys(SEED_PROFILES).join(', ')}`);
const profile = values.profile as SeedProfile;
// The project name appears in every operation ID; choose a label matching the profile.
const project = values.project ?? (profile === 'staydesk' ? 'StayDesk' : 'Hotel demo');
// --until now (or an ISO time) spreads the events over the most recent --days, ending then, with the full mix.
const until = values.until === undefined ? undefined : values.until === 'now' ? new Date() : new Date(values.until);
if (until && Number.isNaN(until.getTime())) throw new Error('--until must be "now" or an ISO date-time');
const events = Number(values.events ?? (project.toLowerCase().includes('ledger') ? 5000 : 300_000)),
  days = Number(values.days);
if (!Number.isInteger(events) || events < 1 || !Number.isFinite(days) || days <= 0) throw new Error('Invalid events/days');
if (!Number.isInteger(Number(values.seed))) throw new Error('Invalid seed');
if (values.reset && !values['project-id']) throw new Error('--reset requires --project-id');
if (!['api', 'direct'].includes(values.sink)) throw new Error('sink must be api or direct');
if (values.sink === 'api' && !values.key) throw new Error('--key is required for the api sink');
const database = values.reset || values.sink === 'direct' ? await import('@logbird/database') : undefined;

async function closeDatabase() {
  if (database) await Promise.all([database.closeProjectLocks(), database.prisma.$disconnect()]);
}

/**
 * Writes that bypass the API (`--reset` and `--sink direct`) are fenced like the server's own maintenance (#296):
 * under the exclusive project lock, after canceling a background retention run staged for the project (it would not
 * count these rows), with `received_at` from the database clock. Without Postgres there is no fence, so they refuse
 * instead of writing unfenced.
 */
async function fenced<T>(projectId: string, reason: string, work: (db: Prisma.TransactionClient) => Promise<T>) {
  if (!database) throw new Error('Postgres is required for direct seeding.');
  const { prisma, withProjectLock, cancelStagedRetention } = database;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    throw new Error(
      'Direct writes (--sink direct, --reset) need Postgres (DATABASE_URL) to fence them against retention and ingest; refusing to write unfenced.',
    );
  }
  return withProjectLock(
    projectId,
    async (db) => {
      await cancelStagedRetention(projectId, db, reason);
      return work(db);
    },
    { waitMs: 60_000 },
  );
}
if (values.reset) {
  // In API mode the supplied project ID must belong to the ingest key. Purging
  // uses local ClickHouse credentials because the public API has no reset route.
  const projectId = values['project-id'] as string;
  let reset = false;
  try {
    await fenced(projectId, 'Seed data was reset during the run; the next run retries.', async (db) => {
      if (await db.ingestReceipt.findFirst({ where: { projectId, confirmedAt: null, claimedAt: { not: null } }, select: { eventId: true } }))
        throw new Error('A write for this project is still unresolved. Retry the reset after ingest recovery.');
      const ch = createClickHouseClient();
      try {
        await purgeProject(ch, projectId);
        // Destructive: readers and caches keyed by the maintenance generation must not reuse facts from before it.
        await db.project.updateMany({ where: { id: projectId }, data: { maintenanceGeneration: { increment: 1 } } });
      } finally {
        await ch.close();
      }
    });
    reset = true;
  } finally {
    if (!reset || values.sink === 'api') await closeDatabase();
  }
}
const generator = generateEvents({
  events,
  days,
  project,
  seed: Number(values.seed),
  profile,
  ...(until ? { now: until, spread: true } : {}),
});
if (values.sink === 'api') {
  if (!values.key) throw new Error('--key is required for the api sink');
  let ingestError: Error | undefined;
  const sdk = new Logbird({
    apiKey: values.key,
    endpoint: values.endpoint,
    batchSize: 1000,
    onError: (error) => {
      ingestError = error;
    },
  });
  let n = 0;
  for (const event of generator) {
    sdk.track(event);
    if (++n % 1000 === 0) await sdk.flush();
  }
  await sdk.shutdown();
  if (ingestError) throw ingestError;
  console.log(`Sent ${n} fictional events through API`);
} else if (values.sink === 'direct') {
  const p = values['project-id'];
  if (!p || !database) throw new Error('--project-id required');
  const { claimIngestReceipts, databaseClock, prisma } = database;
  const ch = createClickHouseClient();
  let n = 0;
  try {
    await fenced(p, 'Seed data was written directly during the run; the next run retries.', async (db) => {
      const { organizationId } = await db.project.findUniqueOrThrow({ where: { id: p }, select: { organizationId: true } });
      let batch: EventRow[] = [];
      // One database-clock reading per batch, as ingest stamps a batch.
      let receivedAt = await databaseClock(db);
      const writeBatch = async () => {
        if (!batch.length) return;
        // Keep a pending receipt until ClickHouse acknowledges every row in the batch. Recovery can then settle a
        // lost response under the same project-wide guard as API ingest.
        const eventId = `logbird-seed-batch-${randomUUID()}`;
        const [claim] = await claimIngestReceipts(
          p,
          organizationId,
          [{ eventId, fingerprint: 'logbird-seed-batch', receivedAt, eventAt: receivedAt, confirmedAt: null }],
          db,
        );
        if (!claim) throw new Error('Could not register the direct seed batch.');
        await insertEvents(ch, batch);
        await prisma.$transaction([
          prisma.project.update({ where: { id: p }, data: { maintenanceGeneration: { increment: 1 } } }),
          prisma.ingestReceipt.deleteMany({ where: { projectId: p, eventId, confirmedAt: null } }),
        ]);
      };
      for (const event of generator) {
        const result = normalizeEvent(event, { projectId: p, receivedAt });
        if (!result.ok) throw new Error(result.reason);
        batch.push(result.row);
        n++;
        if (batch.length === 5000) {
          await writeBatch();
          batch = [];
          receivedAt = await databaseClock(db);
        }
      }
      await writeBatch();
    });
    console.log(`Inserted ${n} fictional events into project ${p}`);
    if (values.benchmark) {
      const to = until ?? new Date();
      const range = { from: new Date(to.getTime() - days * 86_400_000).toISOString(), to: to.toISOString() };
      for (const [name, run] of [
        ['search', () => searchEvents(ch, p, { ...range, limit: 50, order: 'desc' })],
        ['overview', () => overview(ch, p, range)],
        ['histogram', () => histogram(ch, p, range)],
        ['facets', () => facets(ch, p, { ...range, field: 'action', limit: 10 })],
        ['entity lookup', () => listEntities(ch, p, { kind: 'actor', q: 'Noura', limit: 25 })],
      ] as const) {
        const times: number[] = [];
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          await run();
          times.push(Math.round((performance.now() - start) * 100) / 100);
        }
        console.log(JSON.stringify({ name, milliseconds: times }));
      }
    }
  } finally {
    await Promise.all([ch.close(), closeDatabase()]);
  }
} else throw new Error('sink must be api or direct');
