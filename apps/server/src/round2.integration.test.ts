import { randomUUID } from 'node:crypto';
import { getEvent, insertEvents, normalizeEvent, purgeProject } from '@trailmark/clickhouse';
import { prisma } from '@trailmark/database';
import { enforceProjectRetention } from '@trailmark/worker/retention';
import { expect, it } from 'vitest';
import { app } from './app';
import { clickhouse } from './clickhouse';
import { generateApiKey } from './keys';

it('R2-1/2/6/7/10: real HTTP ingest, timestamp readback, exact retention and public schema', async () => {
  const id = randomUUID();
  const org = await prisma.organization.create({ data: { id, name: 'Round two fictional', slug: id, createdAt: new Date() } });
  const project = await prisma.project.create({ data: { organizationId: org.id, name: 'Round two', slug: id, retentionDays: 3650 } });
  const key = generateApiKey('ingest');
  await prisma.apiKey.create({ data: { projectId: project.id, name: 'Round two fictional', kind: 'ingest', hash: key.hash, prefix: key.prefix } });
  try {
    const now = Date.now();
    const stamps = [
      new Date(now - 86_400_000).toISOString(),
      new Date(now + 3_600_000).toISOString(),
      now,
      Math.floor(now / 1000),
      now * 1000,
      '+010000-01-01T00:00:00Z',
      'bad',
      '2000-01-01',
      '2096-03-01',
    ];
    const response = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        stamps.map((occurredAt, i) => ({
          id: `event-${i}`,
          action: 'round.two',
          occurredAt,
          executor: { type: 'api', id: 'demo-api', name: 'Demo API' },
          actor: { id: 'ada', name: 'Ada' },
          metadata: { plan: 'fictional' },
        })),
      ),
    });
    expect(response.status).toBe(202);
    const result = await response.json();
    expect(result.accepted).toBe(3);
    expect(result.rejected.map((r: { index: number }) => r.index)).toEqual([3, 4, 5, 6, 7, 8]);
    for (let i = 0; i < stamps.length; i++) expect(!!(await getEvent(clickhouse, project.id, `event-${i}`))).toBe(i < 3);
    expect(result.rejected[0].reason).toContain('epoch seconds');
    const spec = await (await app.request('/openapi.json')).json();
    const lang = spec.paths['/v1/events'].get.parameters.find((p: { name: string }) => p.name === 'lang');
    expect(JSON.stringify(lang)).not.toContain('sql');
    const started = Date.now();
    await enforceProjectRetention(project.id);
    const run = await prisma.retentionRun.findFirstOrThrow({ where: { projectId: project.id }, orderBy: { startedAt: 'desc' } });
    expect(run.status).toBe('completed');
    expect(run.deletedEvents).toBe(0);
    console.log(`R2-2 no-op retention ${Date.now() - started}ms`);
    // Expiry inside a minute: surviving row shares all entity/key aggregates.
    const cutoff = new Date(Math.floor(now / 60_000) * 60_000 + 30_000);
    const events = [-1000, 1000, 61_000].map((offset, i) =>
      normalizeEvent(
        {
          id: `boundary-${i}`,
          action: 'boundary',
          occurredAt: new Date(cutoff.getTime() + offset).toISOString(),
          actor: { id: 'boundary' },
          metadata: { key: 'v' },
        },
        { projectId: project.id, receivedAt: new Date() },
      ),
    );
    await insertEvents(
      clickhouse,
      events.flatMap((r) => (r.ok ? [r.row] : [])),
    );
    await purgeProject(clickhouse, project.id, cutoff);
    for (const [i, present] of [
      [0, false],
      [1, true],
      [2, true],
    ] as const)
      expect(!!(await getEvent(clickhouse, project.id, `boundary-${i}`))).toBe(present);
    const rows = await (
      await clickhouse.query({
        query: "SELECT sum(events) n FROM entities WHERE project_id={p:String} AND kind='actor' AND entity_id='boundary'",
        query_params: { p: project.id },
        format: 'JSONEachRow',
      })
    ).json<{ n: number }>();
    expect(Number(rows[0]?.n)).toBe(2);
    const keys = await (
      await clickhouse.query({
        query: "SELECT sum(count) n FROM attribute_keys WHERE project_id={p:String} AND key='metadata.key'",
        query_params: { p: project.id },
        format: 'JSONEachRow',
      })
    ).json<{ n: number }>();
    expect(Number(keys[0]?.n)).toBe(2);
    const raw = await (
      await clickhouse.query({
        query: 'SELECT count() n FROM events WHERE project_id={p:String}',
        query_params: { p: project.id },
        format: 'JSONEachRow',
      })
    ).json<{ n: number }>();
    const rollup = await (
      await clickhouse.query({
        query: 'SELECT sum(events) n FROM events_by_minute WHERE project_id={p:String}',
        query_params: { p: project.id },
        format: 'JSONEachRow',
      })
    ).json<{ n: number }>();
    expect(Number(rollup[0]?.n)).toBe(Number(raw[0]?.n));
    console.log('R2-1/6/7/10 accepted=3 rejected=6 all accepted IDs readable; R2-2 raw/minute/entity counts exact');
  } finally {
    await purgeProject(clickhouse, project.id);
    await prisma.organization.delete({ where: { id: org.id } });
  }
}, 120_000);
