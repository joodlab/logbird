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
  searchEvents,
} from '@trailmark/clickhouse';
import { Trailmark } from '@trailmark/sdk';
import { generateEvents } from './index';

const { values } = parseArgs({
  options: {
    sink: { type: 'string', default: 'api' },
    endpoint: { type: 'string', default: 'http://localhost:4601' },
    key: { type: 'string' },
    'project-id': { type: 'string' },
    project: { type: 'string', default: 'JoodCMS' },
    events: { type: 'string' },
    days: { type: 'string', default: '60' },
    seed: { type: 'string', default: '42' },
    benchmark: { type: 'boolean', default: false },
  },
});
const events = Number(values.events ?? (values.project.toLowerCase().includes('ledger') ? 5000 : 300_000)),
  days = Number(values.days);
if (!Number.isInteger(events) || events < 1 || !Number.isFinite(days) || days <= 0) throw new Error('Invalid events/days');
const generator = generateEvents({ events, days, project: values.project, seed: Number(values.seed) });
if (values.sink === 'api') {
  if (!values.key) throw new Error('--key is required for the api sink');
  const sdk = new Trailmark({ apiKey: values.key, endpoint: values.endpoint, batchSize: 1000, onError: (error) => console.error(error.message) });
  let n = 0;
  for (const event of generator) {
    sdk.track(event);
    if (++n % 1000 === 0) await sdk.flush();
  }
  await sdk.shutdown();
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
      const range = { from: new Date(Date.now() - days * 86_400_000).toISOString(), to: new Date().toISOString() };
      for (const [name, run] of [
        ['search', () => searchEvents(ch, p, { ...range, limit: 50, order: 'desc' })],
        ['overview', () => overview(ch, p, range)],
        ['histogram', () => histogram(ch, p, range)],
        ['facets', () => facets(ch, p, { ...range, field: 'action', limit: 10 })],
        ['entity lookup', () => listEntities(ch, p, { kind: 'actor', q: 'operator', limit: 25 })],
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
