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
// The project name ends up in every operation ID, so the neutral profile doesn't default to the StayDesk name.
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
if (values.reset) {
  // In API mode the supplied project ID must belong to the ingest key. Purging
  // uses local ClickHouse credentials because the public API has no reset route.
  const ch = createClickHouseClient();
  try {
    await purgeProject(ch, values['project-id'] as string);
  } finally {
    await ch.close();
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
  if (!p) throw new Error('--project-id required');
  const ch = createClickHouseClient();
  let batch: EventRow[] = [],
    n = 0;
  try {
    for (const event of generator) {
      const result = normalizeEvent(event, { projectId: p, receivedAt: new Date() });
      if (!result.ok) throw new Error(result.reason);
      batch.push(result.row);
      n++;
      if (batch.length === 5000) {
        await insertEvents(ch, batch);
        batch = [];
      }
    }
    await insertEvents(ch, batch);
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
    await ch.close();
  }
} else throw new Error('sink must be api or direct');
