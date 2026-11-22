import { randomUUID } from 'node:crypto';
import { type EntityProfile, encodeRecordPair, formatRecordTerm } from '@logbird/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ClickHouseClient, createClickHouseClient, createQueryClickHouseClient, insertEvents } from './client';
import { normalizeEvent } from './normalize';
import { entityMetadata, entityProfile, exportEvents, facets, listEntities, purgeProject, read, searchEvents } from './queries';
import { compileQuery } from './query';
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
    expect(await entityMetadata(ch, projectId, 'target', 'site:12', 'site')).toMatchObject({ id: 'site:12', type: 'site' });
    expect(await entityMetadata(ch, projectId, 'target', 'site:missing', 'site')).toBeNull();

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

  it('keeps histories and names separate when two pairs share the directory key', async () => {
    const collisionProject = `record-collision-${randomUUID()}`;
    const sqlClient = createQueryClickHouseClient();
    const fixtures = [
      { eventId: 'archived-order', type: 'order:archived', id: 'A1', name: 'Archived order' },
      { eventId: 'regular-order', type: 'order', id: 'archived:A1', name: 'Regular order' },
      { eventId: 'long-record', type: `${'t'.repeat(63)}:`, id: 'i'.repeat(150), name: 'Long record name' },
    ];
    try {
      await insertEvents(
        ch,
        fixtures.map(({ eventId, ...target }) => {
          const event = normalizeEvent(
            { id: eventId, action: `record.${eventId}`, actor: { id: 'record-actor' }, occurredAt: now.toISOString(), targets: [target] },
            { projectId: collisionProject, receivedAt: now },
          );
          if (!event.ok) throw new Error('Invalid collision fixture');
          return event.row;
        }),
      );

      for (const { eventId, type, id, name } of fixtures) {
        const q = formatRecordTerm(type, id);
        const events = await searchEvents(ch, collisionProject, { ...range, limit: 10, order: 'asc', q });
        expect(
          events.data.map((e) => e.id),
          q,
        ).toEqual([eventId]);
        const profile = await entityProfile(ch, collisionProject, 'target', `${type}:${id}`, { ...range, targetType: type });
        expect(profile?.entity).toMatchObject({ type, name, events: 1 });
        expect(await entityMetadata(ch, collisionProject, 'target', `${type}:${id}`, type)).toEqual({
          kind: 'target',
          type,
          id: `${type}:${id}`,
          name,
        });
        expect(profile?.series.buckets.reduce((n, b) => n + b.total, 0)).toBe(1);
        expect(profile?.topActions.map((a) => a.id)).toEqual([`record.${eventId}`]);
        if (sqlClient && type === 'order:archived') {
          const sqlProfile = await entityProfile(sqlClient, collisionProject, 'target', `${type}:${id}`, {
            ...range,
            targetType: type,
            lang: 'sql',
            q: "action IN ('record.archived-order', 'record.regular-order')",
          });
          expect(sqlProfile?.entity).toMatchObject({ type, name, events: 1 });
          expect(sqlProfile?.topActions.map((a) => a.id)).toEqual(['record.archived-order']);
        }
      }

      const suggestions = await suggestValues(ch, collisionProject, { ...range, field: 'record', limit: 10 });
      expect(suggestions.values.map(({ value }) => value).sort()).toEqual(fixtures.map(({ type, id }) => encodeRecordPair(type, id)).sort());
      const directory = await listEntities(ch, collisionProject, { kind: 'target', limit: 10 });
      expect(directory.data.find(({ id }) => id === 'order:archived:A1')?.events).toBe(2);
      const actor = await entityProfile(ch, collisionProject, 'actor', 'record-actor', range);
      expect(
        actor?.related
          .filter(({ kind }) => kind === 'target')
          .map(({ name }) => name)
          .sort(),
      ).toEqual(fixtures.map(({ name }) => name).sort());
    } finally {
      try {
        await purgeProject(ch, collisionProject);
      } finally {
        await sqlClient?.close();
      }
    }
  }, 60_000);

  it('counts duplicate record targets twice in the rollup tile and once in the timeline', async () => {
    const target = { type: 'page', id: 'duplicate-target' };
    const event = normalizeEvent(
      { id: 'repeat', action: 'page.updated', occurredAt: now.toISOString(), targets: [target, target] },
      { projectId, receivedAt: now },
    );
    if (!event.ok) throw new Error('Invalid duplicate-target fixture');
    await insertEvents(ch, [event.row]);

    const profile = await entityProfile(ch, projectId, 'target', 'page:duplicate-target', range);
    expect(profile?.entity.events).toBe(2);
    expect(profile?.outcomes).toEqual({ success: 1 });
    const timeline = await searchEvents(ch, projectId, { ...range, q: 'record:page:duplicate-target', limit: 10, order: 'asc' });
    expect(timeline.data.map(({ id }) => id)).toEqual(['repeat']);
  }, 60_000);

  it.runIf(process.env.CLICKHOUSE_RECORD_EXPLAIN === '1')(
    'prunes multi-granule record searches with idx_targets',
    async () => {
      const scaleProject = `record-index-${randomUUID()}`;
      const predicate = compileQuery('record:page:wanted');
      try {
        await ch.command({
          query: `INSERT INTO events (project_id,event_id,timestamp,action,target_types,target_ids,target_names)
          SELECT {p:String},toString(number),now64(3)+toIntervalMillisecond(number),'page.updated',['page','page','other'],
                 [if(number=199999,'wanted','ordinary'),'section:common','common'],['','Common section',''] FROM numbers(200000)`,
          query_params: { p: scaleProject },
        });
        const params = { p: scaleProject, ...predicate.params };
        const query = `SELECT count() AS count FROM events WHERE project_id={p:String} AND ${predicate.sql}`;
        const [match] = await read<{ count: string | number }>(ch, query, params);
        expect(Number(match?.count)).toBe(1);
        const rows = await read<{ explain: string }>(
          ch,
          `EXPLAIN indexes = 1 ${query} SETTINGS use_query_condition_cache = 0, use_skip_indexes_on_data_read = 0`,
          params,
        );
        const plan = rows.map(({ explain }) => explain).join('\n');
        process.stdout.write(`${plan}\n`);
        const granules = /Name: idx_targets[\s\S]*?Granules: (\d+)\/(\d+)/.exec(plan);
        expect(granules, plan).not.toBeNull();
        expect(Number(granules?.[1])).toBeLessThan(Number(granules?.[2]));

        let started = performance.now();
        expect(await entityMetadata(ch, scaleProject, 'target', 'page:section:common', 'page')).toMatchObject({ name: 'Common section' });
        const hitMs = performance.now() - started;
        // The wanted target ID appears in every row, on another type. The miss exercises the paired predicate after pruning.
        started = performance.now();
        expect(await entityMetadata(ch, scaleProject, 'target', 'page:section:common', 'page:section')).toBeNull();
        process.stdout.write(
          `Metadata lookup across 200000 events: hit ${hitMs.toFixed(1)} ms, paired miss ${(performance.now() - started).toFixed(1)} ms\n`,
        );
      } finally {
        await purgeProject(ch, scaleProject);
      }
      const [remaining] = await read<{ count: string | number }>(ch, 'SELECT count() AS count FROM events WHERE project_id={p:String}', {
        p: scaleProject,
      });
      expect(Number(remaining?.count)).toBe(0);
    },
    120_000,
  );
});
