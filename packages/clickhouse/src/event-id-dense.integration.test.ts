import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@clickhouse/client';
import { expect, it } from 'vitest';
import { createMaintenanceClickHouseClient } from './client';
import { migrateEventIdIndex } from './event-id-migration';

const run = process.env.CLICKHOUSE_ONLINE_DENSE_MIGRATION_TEST === '1';
it.runIf(run).each([-1, 0, 1, 2, 3, 4, 5, 6, 'late-backfill', 'late-retire', 'timeout-copy'] as const)(
  'upgrades the dense index online across interruption %s',
  async (fault) => {
    const ch = createMaintenanceClickHouseClient();
    let timedClient: ReturnType<typeof createClient> | undefined;
    const suffix = randomUUID().replaceAll('-', '');
    const source = `qa_dense_source_${suffix}`,
      table = `qa_dense_ids_${suffix}`,
      temporary = `${table}_v3`;
    const names: Record<string, string> = {
      events: source,
      event_ids: table,
      event_ids_mv: `${table}_mv`,
      event_ids_v2: `${table}_v2`,
      event_ids_v2_mv: `${table}_v2_mv`,
      event_ids_v3: temporary,
      event_ids_v3_mv: `${temporary}_mv`,
    };
    const sql = async (name: string) =>
      (await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'))
        .replace(/\bevent_ids(?:_v[23])?(?:_mv)?\b|\bevents\b/g, (name) => {
          if (!names[name]) throw new Error('Unscoped migration identifier');
          return names[name];
        })
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
    const statements = await sql('008_event_ids_granularity.sql');
    const query = async <T>(sql: string) => (await ch.query({ query: sql, format: 'JSONEachRow' })).json<T>();
    const command = ch.command.bind(ch);
    let writer: Promise<{ ok: boolean; error?: unknown }> | undefined;
    try {
      await command({
        query: `CREATE TABLE ${source} (project_id String,event_id String,received_at DateTime64(3,'UTC'),timestamp DateTime64(3,'UTC')) ENGINE=MergeTree ORDER BY(project_id,timestamp,event_id)`,
      });
      await command({
        query: `CREATE TABLE ${table} AS ${source} ENGINE=${fault === -1 ? 'ReplacingMergeTree(received_at) ORDER BY(project_id,event_id)' : 'MergeTree ORDER BY(project_id,event_id,received_at,timestamp)'} SETTINGS index_granularity=8192`,
      });
      await command({ query: `CREATE MATERIALIZED VIEW ${table}_mv TO ${table} AS SELECT project_id,event_id,received_at,timestamp FROM ${source}` });
      await command({ query: `INSERT INTO ${source} SELECT 'fictional',concat('before-',toString(number)),now64(3),now64(3) FROM numbers(10)` });
      if (fault === -1) {
        for (const age of [2, 1])
          await command({
            query: `INSERT INTO ${source} SELECT 'fictional','legacy',now64(3)-INTERVAL ${age} SECOND,now64(3)-INTERVAL ${age === 1 ? 91 : 3} DAY`,
          });
        await command({ query: `OPTIMIZE TABLE ${table} FINAL` });
        expect((await query<{ n: number }>(`SELECT count() n FROM ${table} WHERE event_id='legacy'`))[0]?.n).toBe(1);
        await migrateEventIdIndex(ch, await sql('007_event_ids_merge_tree.sql'), { table, temporary: `${table}_v2`, source });
        expect((await query<{ n: number }>(`SELECT uniqExact((received_at,timestamp)) n FROM ${table} WHERE event_id='legacy'`))[0]?.n).toBe(2);
        // Upgrade coverage is mandatory before cutoff cleanup: the newest replacing pointer was expired.
        for (const name of [source, table])
          await command({
            query: `DELETE FROM ${name} WHERE timestamp<now64(3)-INTERVAL 90 DAY`,
            clickhouse_settings: { mutations_sync: '2', lightweight_deletes_sync: '2' },
          });
        expect((await query<{ n: number }>(`SELECT count() n FROM ${table} WHERE event_id='legacy'`))[0]?.n).toBe(1);
      }
      const late = fault === 'late-backfill' || fault === 'late-retire';
      const writerId = randomUUID();
      writer = (
        late
          ? command({
              query: `INSERT INTO ${source} SELECT 'fictional',concat('late-',toString(number)),now64(3),now64(3) FROM numbers(100) WHERE sleepEachRow(0.02)=0`,
              query_id: writerId,
            })
          : (async () => {
              for (let i = 0; i < 20; i++) {
                await command({ query: `INSERT INTO ${source} SELECT 'fictional','concurrent-${i}',now64(3),now64(3)` });
                await new Promise((r) => setTimeout(r, 5));
              }
            })()
      ).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
      if (late) {
        let active = false;
        for (let i = 0; i < 100; i++) {
          const n = await query<{ n: number }>(`SELECT count() n FROM system.processes WHERE query_id='${writerId}'`);
          if (n[0]?.n) {
            active = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(active).toBe(true);
        await new Promise((r) => setTimeout(r, 100));
      }
      let armed = typeof fault === 'number' && fault >= 0;
      let timedOut = false;
      let timedUuid: string | undefined;
      const timedQueryId = randomUUID();
      ch.command = async (params) => {
        if (fault === 'timeout-copy' && params.query === statements[2] && !timedOut) {
          timedOut = true;
          timedUuid = (
            await query<{ uuid: string }>(`SELECT toString(uuid) uuid FROM system.tables WHERE database=currentDatabase() AND name='${temporary}'`)
          )[0]?.uuid;
          timedClient = createClient({
            url: process.env.CLICKHOUSE_URL,
            database: process.env.CLICKHOUSE_DATABASE,
            username: process.env.CLICKHOUSE_USER,
            password: process.env.CLICKHOUSE_PASSWORD,
            request_timeout: 50,
          });
          return timedClient.command({ ...params, query: `${params.query} WHERE sleepEachRow(0.05)=0`, query_id: timedQueryId });
        }
        const result = await command(params);
        if (params.query === statements[2] && fault === 'late-backfill') expect((await writer)?.ok).toBe(true);
        if (armed && statements.indexOf(params.query) === fault) {
          armed = false;
          throw new Error('Injected dense migration interruption');
        }
        return result;
      };
      const migrate = () => migrateEventIdIndex(ch, statements, { table, temporary, source, granularity: 256 });
      if (armed) await expect(migrate()).rejects.toThrow('Injected dense migration interruption');
      if (fault === 'timeout-copy') {
        await expect(migrate()).rejects.toThrow(/timeout/i);
        expect((await query<{ n: number }>(`SELECT count() n FROM system.processes WHERE query_id='${timedQueryId}'`))[0]?.n).toBe(1);
      }
      await migrate();
      await migrate();
      const written = await writer;
      expect(written.ok, String(written.error)).toBe(true);
      await command({ query: `INSERT INTO ${source} SELECT 'fictional','after',now64(3),now64(3)` });
      const counts = await query<{ raw: number; ids: number; missing: number }>(
        `SELECT (SELECT count() FROM ${source}) raw,(SELECT uniqExact((project_id,event_id,received_at,timestamp)) FROM ${table}) ids,(SELECT count() FROM ${source} WHERE (project_id,event_id,received_at,timestamp) NOT IN (SELECT project_id,event_id,received_at,timestamp FROM ${table})) missing`,
      );
      expect(counts[0]).toEqual({ raw: late ? 111 : fault === -1 ? 32 : 31, ids: late ? 111 : fault === -1 ? 32 : 31, missing: 0 });
      if (fault === 'timeout-copy') {
        expect(
          (await query<{ uuid: string }>(`SELECT toString(uuid) uuid FROM system.tables WHERE database=currentDatabase() AND name='${table}'`))[0]
            ?.uuid,
        ).not.toBe(timedUuid);
        expect((await query<{ n: number }>(`SELECT count() n FROM ${table} WHERE startsWith(event_id,'before-')`))[0]?.n).toBe(10);
        expect((await query<{ n: number }>(`SELECT count() n FROM system.processes WHERE query_id='${timedQueryId}'`))[0]?.n).toBe(0);
      }
      const state = await query<{ name: string; create_table_query: string }>(
        `SELECT name,create_table_query FROM system.tables WHERE database=currentDatabase() AND name IN ('${table}','${temporary}','${table}_mv','${temporary}_mv')`,
      );
      expect(state.map((r) => r.name).sort()).toEqual([table, `${table}_mv`].sort());
      expect(state.find((r) => r.name === table)?.create_table_query).toMatch(/index_granularity\s*=\s*256\b/);
      console.log(JSON.stringify({ fault, writer: written, counts: counts[0] }));
    } finally {
      ch.command = command;
      if (writer) await writer;
      for (const name of [`${temporary}_mv`, `${table}_v2_mv`, `${table}_mv`]) await command({ query: `DROP VIEW IF EXISTS ${name} SYNC` });
      for (const name of [temporary, `${table}_v2`, table, source]) await command({ query: `DROP TABLE IF EXISTS ${name} SYNC` });
      await ch.close();
      await timedClient?.close();
    }
  },
  60_000,
);
