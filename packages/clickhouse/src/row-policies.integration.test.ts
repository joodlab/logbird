import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClickHouseClient, createQueryClickHouseClient, insertEvents } from './client';
import { normalizeEvent } from './normalize';
import { entityProfile, listFields, liveEvents, overview, projectStats } from './queries';

const enabled = !!process.env.CLICKHOUSE_QUERY_PASSWORD;
const main = enabled ? createClickHouseClient() : null;
const restricted = enabled ? createQueryClickHouseClient() : null;
const projects = [`row-policy-a-${randomUUID()}`, `row-policy-b-${randomUUID()}`];
const ddlTable = `trailmark_row_policy_probe_${randomUUID().replaceAll('-', '')}`;
const now = new Date();
const range = {
  lang: 'sql' as const,
  q: '1 OR 1',
  from: new Date(now.getTime() - 1000).toISOString(),
  to: new Date(now.getTime() + 1000).toISOString(),
};
const tables = ['events', 'events_by_minute', 'entities', 'attribute_keys'];
afterAll(async () => {
  if (main) await main.command({ query: `DROP TABLE IF EXISTS trailmark.${ddlTable}` });
  await main?.close();
  await restricted?.close();
});

describe.runIf(enabled)('database-enforced project isolation (real ClickHouse)', () => {
  beforeAll(async () => {
    await main!.command({ query: `CREATE TABLE trailmark.${ddlTable} (project_id String) ENGINE=Memory` });
    for (const projectId of projects) {
      const row = normalizeEvent(
        {
          id: randomUUID(),
          action: 'row.policy',
          actor: { id: projectId, type: 'user' },
          metadata: { policy: projectId },
          occurredAt: now.toISOString(),
        },
        { projectId, receivedAt: now },
      );
      if (!row.ok) throw new Error('Fixture normalization failed');
      await insertEvents(main!, [row.row]);
    }
  });

  it('checks no-policy semantics and preserves other users with a companion policy', async () => {
    await main!.command({ query: `INSERT INTO trailmark.${ddlTable} VALUES ('a'),('b')` });
    await main!.command({
      query: `CREATE ROW POLICY trailmark_semantics_probe ON trailmark.${ddlTable} USING project_id = getSetting('SQL_trailmark_project') TO trailmark_query`,
    });
    try {
      const count = async () =>
        (await (await main!.query({ query: `SELECT count() n FROM trailmark.${ddlTable}`, format: 'JSONEachRow' })).json<{ n: number }>())[0]!.n;
      const withoutCompanion = await count();
      expect([0, 2]).toContain(Number(withoutCompanion));
      process.stdout.write(`${JSON.stringify({ mainRowsWithoutCompanion: withoutCompanion })}\n`);
      await main!.command({
        query: `CREATE ROW POLICY trailmark_semantics_companion ON trailmark.${ddlTable} USING 1 TO ALL EXCEPT trailmark_query`,
      });
      expect(Number(await count())).toBe(2);
    } finally {
      await main!.command({ query: `DROP ROW POLICY IF EXISTS trailmark_semantics_probe ON trailmark.${ddlTable}` });
      await main!.command({ query: `DROP ROW POLICY IF EXISTS trailmark_semantics_companion ON trailmark.${ddlTable}` });
    }
  });

  it.each(tables)('%s enforces policy without validateSql or application project predicates', async (table) => {
    const baseline = await (
      await main!.query({
        query: `SELECT count() n FROM trailmark.${table} WHERE project_id={p:String}`,
        query_params: { p: projects[0] },
        format: 'JSONEachRow',
      })
    ).json<{ n: number }>();
    expect(Number(baseline[0]!.n)).toBeGreaterThan(0);
    for (const predicate of ['1 OR 1', "project_id != ''"]) {
      const rows = await (
        await restricted!.query({
          query: `SELECT project_id,count() n FROM trailmark.${table} WHERE ${predicate} GROUP BY project_id`,
          clickhouse_settings: { SQL_trailmark_project: projects[0]! },
          format: 'JSONEachRow',
        })
      ).json<{ project_id: string; n: number }>();
      expect(rows.map((r) => r.project_id)).toEqual([projects[0]]);
      expect(Number(rows[0]!.n)).toBe(Number(baseline[0]!.n));
    }
    const mainRows = await (
      await main!.query({
        query: `SELECT DISTINCT project_id FROM trailmark.${table} WHERE project_id IN {projects:Array(String)}`,
        query_params: { projects },
        format: 'JSONEachRow',
      })
    ).json<{ project_id: string }>();
    expect(mainRows.map((r) => r.project_id).sort()).toEqual([...projects].sort());
  });

  it.each(tables)('%s fails closed without a setting, including after a bound query on the same client', async (table) => {
    await expect(restricted!.query({ query: `SELECT count() FROM trailmark.${table}` })).rejects.toThrow(/UNKNOWN_SETTING|Unknown setting/);
  });

  it('direct count sees exactly one fixture event and concurrent request bindings do not leak', async () => {
    const results = await Promise.all(
      [...projects, ...projects].map(async (project) =>
        (
          await restricted!.query({
            query: 'SELECT project_id,count() n FROM trailmark.events GROUP BY project_id',
            clickhouse_settings: { SQL_trailmark_project: project! },
            format: 'JSONEachRow',
          })
        ).json<{ project_id: string; n: number }>(),
      ),
    );
    for (const [i, rows] of results.entries()) expect(rows).toEqual([{ project_id: projects[i % 2], n: 1 }]);
    const rows = await (
      await restricted!.query({
        query: 'SELECT count() n FROM trailmark.events',
        clickhouse_settings: { SQL_trailmark_project: projects[0]! },
        format: 'JSONEachRow',
      })
    ).json();
    expect(rows).toEqual([{ n: 1 }]);
  });

  it.each([
    'readonly=0',
    'readonly=1',
    'allow_ddl=1',
    'max_execution_time=11',
    'max_execution_time=0',
    'max_rows_to_read=5000001',
    'max_rows_to_read=0',
    'max_memory_usage=0',
    'max_bytes_to_read=0',
    'max_result_rows=0',
    "result_overflow_mode='break'",
    'max_threads=8',
    'max_query_size=0',
    'max_ast_depth=0',
  ])('denies settings escalation: %s', async (setting) => {
    await expect(
      restricted!.query({ query: `SELECT 1 SETTINGS ${setting}`, clickhouse_settings: { SQL_trailmark_project: projects[0]! } }),
    ).rejects.toThrow(/READONLY|constraint|Cannot modify|should not/i);
  });

  it('cannot escape constraints or policies by selecting the default profile', async () => {
    const rows = await (
      await restricted!.query({
        query:
          "SELECT project_id,getSetting('readonly') readonly,getSetting('max_execution_time') budget FROM trailmark.events SETTINGS profile='default'",
        clickhouse_settings: { SQL_trailmark_project: projects[0]! },
        format: 'JSONEachRow',
      })
    ).json();
    expect(rows).toEqual([{ project_id: projects[0], readonly: 2, budget: 10 }]);
    await expect(restricted!.query({ query: "SELECT 1 SETTINGS profile='default',max_execution_time=0" }).then((r) => r.text())).rejects.toThrow(
      /READONLY|constraint|Cannot modify|should not/i,
    );
  });

  it.each([
    "INSERT INTO trailmark.events (project_id,action) VALUES ('row-policy-forbidden','forbidden')",
    'ALTER TABLE trailmark.events ADD COLUMN trailmark_forbidden UInt8',
    'CREATE TABLE trailmark.trailmark_forbidden (x UInt8) ENGINE=Memory',
    `DROP TABLE trailmark.${ddlTable}`,
  ])('denies writes and DDL: %s', async (query) => {
    await expect(restricted!.query({ query, clickhouse_settings: { SQL_trailmark_project: projects[0]! } })).rejects.toThrow(
      /READONLY|read.?only|not allowed|ACCESS_DENIED|Not enough privileges/i,
    );
  });

  it('binds overview rollups, live, entity profile, fields and project stats', async () => {
    const p = projects[0]!;
    expect((await overview(restricted!, p, range)).kpis.events).toBe(1);
    expect((await liveEvents(restricted!, p, { ...range, since: range.from, limit: 10 })).map((e) => e.projectId)).toEqual([p]);
    expect((await entityProfile(restricted!, p, 'actor', p, range))?.entity.id).toBe(p);
    expect((await listFields(restricted!, p, range)).data.find((f) => f.key === 'attr.metadata.policy')?.samples).toEqual([p]);
    const stats = await projectStats(restricted!, projects);
    expect(Object.keys(stats).sort()).toEqual([...projects].sort());
    expect(Object.values(stats).map((s) => s.eventsLast24h)).toEqual([1, 1]);
  });
});
