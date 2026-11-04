import { createClickHouseClient, facets, histogram, listEntities, overview, projectStats, searchEvents } from '../src/index';

const ch = createClickHouseClient();
try {
  const range = { from: new Date(Date.now() - 60 * 86_400_000).toISOString(), to: new Date().toISOString() };
  for (const p of ['seed-staydesk-dev', 'seed-ledger-dev']) {
    console.log(JSON.stringify({ project: p, stats: (await projectStats(ch, [p]))[p] }));
    for (const [name, run] of [
      ['search', () => searchEvents(ch, p, { ...range, limit: 50, order: 'desc' })],
      ['overview', () => overview(ch, p, range)],
      ['histogram', () => histogram(ch, p, range)],
      ['facets', () => facets(ch, p, { ...range, field: 'action', limit: 10 })],
      ['entity', () => listEntities(ch, p, { kind: 'actor', q: 'operator', limit: 25 })],
    ] as const) {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await run();
        times.push(Math.round((performance.now() - start) * 100) / 100);
      }
      console.log(JSON.stringify({ project: p, name, milliseconds: times }));
    }
  }
} finally {
  await ch.close();
}
