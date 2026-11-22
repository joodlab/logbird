import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClickHouseClient, createQueryClickHouseClient, insertEvents, withTenant } from './client';
import { normalizeEvent } from './normalize';
import { entityProfile, getEvent, listFields, liveEvents, overview, projectStats, purgeProject, read, searchEvents } from './queries';

/**
 * This suite probes the row policies the migrations install on the `logbird` database (and writes a probe table and
 * fixture events there). It runs only when the environment explicitly selects that database: on a shared machine it
 * must never create, insert into or query a database it was not told to use.
 */
const REQUIRED_DATABASE = 'logbird';
const selectedDatabase = process.env.CLICKHOUSE_DATABASE;
const enabled = !!process.env.CLICKHOUSE_QUERY_PASSWORD && selectedDatabase === REQUIRED_DATABASE;
if (process.env.CLICKHOUSE_QUERY_PASSWORD && !enabled)
  console.warn(
    `row-policies: skipped. It needs CLICKHOUSE_DATABASE=${REQUIRED_DATABASE} (the database whose row policies it probes); got ${selectedDatabase ?? 'none'}.`,
  );
const main = enabled ? createClickHouseClient() : null;
const restricted = enabled ? createQueryClickHouseClient() : null;
const projects = [`row-policy-a-${randomUUID()}`, `row-policy-b-${randomUUID()}`];
const ddlTable = `logbird_row_policy_probe_${randomUUID().replaceAll('-', '')}`;
const now = new Date();
const range = {
  lang: 'sql' as const,
  q: '1 OR 1',
  from: new Date(now.getTime() - 1000).toISOString(),
  to: new Date(now.getTime() + 1000).toISOString(),
};
const tables = ['events', 'events_by_minute', 'entities', 'attribute_keys'];
afterAll(async () => {
  if (main) {
    await main.command({ query: `DROP TABLE IF EXISTS logbird.${ddlTable}` });
    // The fixture projects' events (and their rollups) go too, not only the probe table.
    for (const projectId of projects) await purgeProject(main, projectId);
  }
  await main?.close();
  await restricted?.close();
  // Purging runs mutations on the events and rollup tables: allow them to finish.
}, 120_000);

describe.runIf(enabled)('database-enforced project isolation (real ClickHouse)', () => {
  beforeAll(async () => {
    await main!.command({ query: `CREATE TABLE logbird.${ddlTable} (project_id String) ENGINE=Memory` });
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
    await main!.command({ query: `INSERT INTO logbird.${ddlTable} VALUES ('a'),('b')` });
    await main!.command({
      query: `CREATE ROW POLICY logbird_semantics_probe ON logbird.${ddlTable} USING project_id = getSetting('SQL_logbird_project') TO logbird_query`,
    });
    try {
      const count = async () =>
        (await (await main!.query({ query: `SELECT count() n FROM logbird.${ddlTable}`, format: 'JSONEachRow' })).json<{ n: number }>())[0]!.n;
      const withoutCompanion = await count();
      expect([0, 2]).toContain(Number(withoutCompanion));
      process.stdout.write(`${JSON.stringify({ mainRowsWithoutCompanion: withoutCompanion })}\n`);
      await main!.command({
        query: `CREATE ROW POLICY logbird_semantics_companion ON logbird.${ddlTable} USING 1 TO ALL EXCEPT logbird_query`,
      });
      expect(Number(await count())).toBe(2);
    } finally {
      await main!.command({ query: `DROP ROW POLICY IF EXISTS logbird_semantics_probe ON logbird.${ddlTable}` });
      await main!.command({ query: `DROP ROW POLICY IF EXISTS logbird_semantics_companion ON logbird.${ddlTable}` });
    }
  });

  it.each(tables)('%s enforces policy without validateSql or application project predicates', async (table) => {
    const baseline = await (
      await main!.query({
        query: `SELECT count() n FROM logbird.${table} WHERE project_id={p:String}`,
        query_params: { p: projects[0] },
        format: 'JSONEachRow',
      })
    ).json<{ n: number }>();
    expect(Number(baseline[0]!.n)).toBeGreaterThan(0);
    for (const predicate of ['1 OR 1', "project_id != ''"]) {
      const rows = await (
        await restricted!.query({
          query: `SELECT project_id,count() n FROM logbird.${table} WHERE ${predicate} GROUP BY project_id`,
          clickhouse_settings: { SQL_logbird_project: projects[0]! },
          format: 'JSONEachRow',
        })
      ).json<{ project_id: string; n: number }>();
      expect(rows.map((r) => r.project_id)).toEqual([projects[0]]);
      expect(Number(rows[0]!.n)).toBe(Number(baseline[0]!.n));
    }
    const mainRows = await (
      await main!.query({
        query: `SELECT DISTINCT project_id FROM logbird.${table} WHERE project_id IN {projects:Array(String)}`,
        query_params: { projects },
        format: 'JSONEachRow',
      })
    ).json<{ project_id: string }>();
    expect(mainRows.map((r) => r.project_id).sort()).toEqual([...projects].sort());
  });

  it.each(tables)('%s fails closed without a setting, including after a bound query on the same client', async (table) => {
    await expect(restricted!.query({ query: `SELECT count() FROM logbird.${table}` })).rejects.toThrow(/UNKNOWN_SETTING|Unknown setting/);
  });

  it('direct count sees exactly one fixture event and concurrent request bindings do not leak', async () => {
    const results = await Promise.all(
      [...projects, ...projects].map(async (project) =>
        (
          await restricted!.query({
            query: 'SELECT project_id,count() n FROM logbird.events GROUP BY project_id',
            clickhouse_settings: { SQL_logbird_project: project! },
            format: 'JSONEachRow',
          })
        ).json<{ project_id: string; n: number }>(),
      ),
    );
    for (const [i, rows] of results.entries()) expect(rows).toEqual([{ project_id: projects[i % 2], n: 1 }]);
    const rows = await (
      await restricted!.query({
        query: 'SELECT count() n FROM logbird.events',
        clickhouse_settings: { SQL_logbird_project: projects[0]! },
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
      restricted!.query({ query: `SELECT 1 SETTINGS ${setting}`, clickhouse_settings: { SQL_logbird_project: projects[0]! } }),
    ).rejects.toThrow(/READONLY|constraint|Cannot modify|should not/i);
  });

  it('cannot escape constraints or policies by selecting the default profile', async () => {
    const rows = await (
      await restricted!.query({
        query:
          "SELECT project_id,getSetting('readonly') readonly,getSetting('max_execution_time') budget FROM logbird.events SETTINGS profile='default'",
        clickhouse_settings: { SQL_logbird_project: projects[0]! },
        format: 'JSONEachRow',
      })
    ).json();
    expect(rows).toEqual([{ project_id: projects[0], readonly: 2, budget: 10 }]);
    await expect(restricted!.query({ query: "SELECT 1 SETTINGS profile='default',max_execution_time=0" }).then((r) => r.text())).rejects.toThrow(
      /READONLY|constraint|Cannot modify|should not/i,
    );
  });

  it.each([
    "INSERT INTO logbird.events (project_id,action) VALUES ('row-policy-forbidden','forbidden')",
    'ALTER TABLE logbird.events ADD COLUMN logbird_forbidden UInt8',
    'CREATE TABLE logbird.logbird_forbidden (x UInt8) ENGINE=Memory',
    `DROP TABLE logbird.${ddlTable}`,
  ])('denies writes and DDL: %s', async (query) => {
    await expect(restricted!.query({ query, clickhouse_settings: { SQL_logbird_project: projects[0]! } })).rejects.toThrow(
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

describe.runIf(enabled)('#138 phase 2: database-enforced tenant binding for scoped reads (real ClickHouse)', () => {
  const tenantProject = `row-policy-tenant-${randomUUID()}`;
  beforeAll(async () => {
    const rows = ['t1', 't2', ''].map((tenant, n) => {
      const row = normalizeEvent(
        {
          id: `tenant-${n}`,
          action: 'row.policy.tenant',
          tenant: tenant ? { id: tenant } : undefined,
          metadata: { policy: 'tenant' },
          occurredAt: now.toISOString(),
        },
        { projectId: tenantProject, receivedAt: now },
      );
      if (!row.ok) throw new Error('Fixture normalization failed');
      return row.row;
    });
    await insertEvents(main!, rows);
  });
  afterAll(async () => {
    if (main) await purgeProject(main, tenantProject);
  }, 120_000);
  const tenants = async (settings: Record<string, string>, predicate = '1 OR 1') =>
    (
      await (
        await restricted!.query({
          query: `SELECT tenant_id FROM logbird.events WHERE ${predicate} ORDER BY tenant_id`,
          clickhouse_settings: { SQL_logbird_project: tenantProject, ...settings },
          format: 'JSONEachRow',
        })
      ).json<{ tenant_id: string }>()
    ).map((r) => r.tenant_id);

  it('installs the tenant-aware policy on every table', async () => {
    const policies = await (
      await main!.query({
        query: "SELECT table, select_filter FROM system.row_policies WHERE short_name = 'logbird_project_isolation' AND database = 'logbird'",
        format: 'JSONEachRow',
      })
    ).json<{ table: string; select_filter: string }>();
    expect(policies.map((p) => p.table).sort()).toEqual([...tables].sort());
    for (const policy of policies) expect(policy.select_filter).toContain('SQL_logbird_tenant');
  });

  it('binds events to the tenant even when the query has no tenant predicate, and leaves unscoped reads unchanged', async () => {
    expect(await tenants({ SQL_logbird_tenant: 't1' })).toEqual(['t1']);
    expect(await tenants({ SQL_logbird_tenant: 't1' }, "tenant_id = 't2' OR tenant_id = ''")).toEqual([]);
    expect(await tenants({ SQL_logbird_tenant: 't2' })).toEqual(['t2']);
    expect(await tenants({ SQL_logbird_tenant: 'nobody' })).toEqual([]);
    // Unscoped: explicitly empty, or not sent at all (profile default) — every tenant of the bound project.
    expect(await tenants({ SQL_logbird_tenant: '' })).toEqual(['', 't1', 't2']);
    expect(await tenants({})).toEqual(['', 't1', 't2']);
  });

  it.each(tables.filter((t) => t !== 'events'))('%s (no tenant column) shows nothing to a tenant-bound session', async (table) => {
    const count = async (settings: Record<string, string>) =>
      Number(
        (
          await (
            await restricted!.query({
              query: `SELECT count() n FROM logbird.${table}`,
              clickhouse_settings: { SQL_logbird_project: tenantProject, ...settings },
              format: 'JSONEachRow',
            })
          ).json<{ n: number }>()
        )[0]?.n,
      );
    expect(await count({ SQL_logbird_tenant: 't1' })).toBe(0);
    expect(await count({})).toBeGreaterThan(0); // the rollup really has rows for this project
  });

  it('a tenant-bound client stays bound even when the query carries no scope at all', async () => {
    const bound = withTenant(restricted!, 't1');
    // No scope predicate, no scope parameter: only the row policy stands between this query and other tenants.
    const rows = await read<{ tenant_id: string }>(bound, 'SELECT tenant_id FROM events WHERE project_id={p:String} ORDER BY tenant_id', {
      p: tenantProject,
    });
    expect(rows.map((r) => r.tenant_id)).toEqual(['t1']);
    // A scope parameter naming another tenant is refused before the query runs.
    await expect(read(bound, 'SELECT 1 FROM events WHERE project_id={p:String}', { p: tenantProject, scope_tenant: 't2' })).rejects.toThrow(
      'Scope tenant does not match the bound tenant',
    );
    expect(() => withTenant(main!, 't1')).toThrow();
  });

  it('detail keeps the project-wide canonical version: a later version of another tenant is not revealed', async () => {
    // Two stored versions of one id (legacy duplicates): the canonical (oldest receipt) belongs to tA, a later one to tB.
    const dupe = `dup-${randomUUID()}`;
    const version = (tenant: string, receivedAt: Date, extra: Record<string, unknown> = {}) => {
      const row = normalizeEvent(
        { id: dupe, action: 'row.policy.dup', tenant: { id: tenant }, occurredAt: receivedAt.toISOString(), ...extra },
        {
          projectId: tenantProject,
          receivedAt,
        },
      );
      if (!row.ok) throw new Error('Fixture normalization failed');
      return row.row;
    };
    const child = normalizeEvent(
      {
        id: `child-${randomUUID()}`,
        action: 'row.policy.child',
        tenant: { id: 'tB' },
        context: { parentEventId: dupe },
        occurredAt: now.toISOString(),
      },
      { projectId: tenantProject, receivedAt: new Date(now.getTime() + 2000) },
    );
    if (!child.ok) throw new Error('Fixture normalization failed');
    // Distinct occurrence times and separate inserts keep both versions (same-key rows are replaced by ReplacingMergeTree).
    await insertEvents(main!, [version('tA', new Date(now.getTime() - 1000))]);
    await insertEvents(main!, [version('tB', new Date(now.getTime() + 1000))]);
    await insertEvents(main!, [child.row]);
    const tB = withTenant(restricted!, 'tB');
    expect(await getEvent(tB, tenantProject, dupe, { tenantId: 'tB' }, main!)).toBeNull();
    const tA = await getEvent(withTenant(restricted!, 'tA'), tenantProject, dupe, { tenantId: 'tA' }, main!);
    expect(tA?.event.tenant?.id).toBe('tA');
    // Parent traversal stops at the out-of-scope canonical parent instead of following tB's later copy.
    const ofChild = await getEvent(tB, tenantProject, child.row.event_id, { tenantId: 'tB' }, main!);
    expect(ofChild?.event.id).toBe(child.row.event_id);
    expect(ofChild?.parents).toEqual([]);
  });

  it('the application read path binds the scope tenant automatically', async () => {
    const page = await searchEvents(
      restricted!,
      tenantProject,
      { from: new Date(now.getTime() - 1000).toISOString(), to: new Date(now.getTime() + 1000).toISOString(), limit: 10, order: 'desc' },
      undefined,
      { tenantId: 't1' },
    );
    expect(page.data.map((e) => e.tenant?.id)).toEqual(['t1']);
    expect(page.total).toBe(1);
  });
});
