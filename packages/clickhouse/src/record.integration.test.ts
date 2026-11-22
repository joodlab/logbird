import { randomUUID } from 'node:crypto';
import type { EntityProfile } from '@logbird/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ClickHouseClient, createClickHouseClient, createQueryClickHouseClient, insertEvents } from './client';
import { normalizeEvent } from './normalize';
import { entityProfile, exportEvents, facets, listEntities, purgeProject, searchEvents } from './queries';
import { suggestValues } from './suggest';

function expectSiteProfile(profile: EntityProfile | null) {
  expect(profile?.entity.events).toBe(1);
  expect(profile?.series.buckets.reduce((total, bucket) => total + bucket.total, 0)).toBe(1);
  expect(profile?.topActions.map(({ id, count }) => ({ id, count }))).toEqual([{ id: 'site.published', count: 1 }]);
  expect(profile?.outcomes).toEqual({ success: 1 });
  expect(profile?.related.map(({ id, kind, count }) => ({ id, kind, count }))).toEqual([{ id: 'publishing-actor', kind: 'actor', count: 1 }]);
}

describe.runIf(process.env.CLICKHOUSE_URL)('record selectors on real ClickHouse', () => {
  let ch: ClickHouseClient;
  const projectId = `record-pair-${randomUUID()}`;
  const now = new Date();
  const range = { from: new Date(now.getTime() - 1000).toISOString(), to: new Date(now.getTime() + 1000).toISOString() };

  beforeAll(async () => {
    ch = createClickHouseClient();
    const fixtures = [
      {
        id: 'separate',
        action: 'page.updated',
        outcome: 'failure',
        actor: { id: 'different-actor' },
        targets: [
          { type: 'page', id: '12' },
          { type: 'site', id: '7' },
        ],
      },
      { id: 'paired', action: 'site.published', outcome: 'success', actor: { id: 'publishing-actor' }, targets: [{ type: 'site', id: '12' }] },
      { id: 'no-targets', action: 'job.started', outcome: 'success' },
    ];
    await insertEvents(
      ch,
      fixtures.map((fixture) => {
        const normalized = normalizeEvent({ ...fixture, occurredAt: now.toISOString() }, { projectId, receivedAt: now });
        if (!normalized.ok) throw new Error('Invalid record fixture');
        return normalized.row;
      }),
    );
  }, 60_000);

  afterAll(async () => {
    try {
      await purgeProject(ch, projectId);
    } finally {
      await ch.close();
    }
  }, 60_000);

  it('matches exact record pairs in search, profiles and exports', async () => {
    for (const [q, ids] of [
      ['record:site:12', ['paired']],
      ['target:12 target.type:site', ['paired', 'separate']],
      ['record:(page:12 OR site:12)', ['paired', 'separate']],
      ['-record:(page:12 OR site:12)', ['no-targets']],
      ['_exists_:record', ['paired', 'separate']],
      ['-record:*', ['no-targets']],
    ] as const) {
      const result = await searchEvents(ch, projectId, { ...range, limit: 10, order: 'asc', q });
      expect(
        result.data.map((event) => event.id),
        q,
      ).toEqual(ids);
    }

    expectSiteProfile(await entityProfile(ch, projectId, 'target', 'site:12', { ...range, q: 'record:site:7 OR record:site:12' }));

    const records = ['page:12', 'site:12', 'site:7'];
    expect((await listEntities(ch, projectId, { kind: 'target', limit: 10 })).data.map((r) => r.id).sort()).toEqual(records);
    expect((await facets(ch, projectId, { ...range, field: 'target', limit: 10 })).values.map(({ value, count }) => [value, count])).toEqual([
      ['12', 2],
      ['7', 1],
    ]);
    expect((await facets(ch, projectId, { ...range, field: 'target.type', limit: 10 })).values.map(({ value, count }) => [value, count])).toEqual([
      ['site', 2],
      ['page', 1],
    ]);
    for (const [filter, expected] of [
      [{}, records],
      [{ ...range, q: 'record:site:12' }, ['site:12']],
    ] as const) {
      const suggestions = await suggestValues(ch, projectId, { ...filter, field: 'record', limit: 10 });
      expect(suggestions.values.map((r) => r.value)).toEqual(expected);
    }

    const exported: string[] = [];
    for await (const line of exportEvents(ch, projectId, { ...range, format: 'jsonl', q: 'record:site:12' })) {
      exported.push(JSON.parse(line).id);
    }
    expect(exported).toEqual(['paired']);
  }, 60_000);

  it.runIf(process.env.CLICKHOUSE_QUERY_USER && process.env.CLICKHOUSE_QUERY_PASSWORD)(
    'scopes SQL-mode profiles to the exact record pair',
    async () => {
      const sqlClient = createQueryClickHouseClient();
      if (!sqlClient) throw new Error('The restricted ClickHouse query user is required for SQL-mode profile verification');
      try {
        expectSiteProfile(
          await entityProfile(sqlClient, projectId, 'target', 'site:12', {
            ...range,
            lang: 'sql',
            q: "arrayExists((t, i) -> t = 'site' AND i = '7', target_types, target_ids) OR outcome = 'success'",
          }),
        );
      } finally {
        await sqlClient.close();
      }
    },
    60_000,
  );
});
