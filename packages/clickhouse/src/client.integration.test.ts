import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { AmbiguousInsertError, createClickHouseClient, insertEvents } from './client';
import { normalizeEvent } from './normalize';

it.runIf(process.env.CLICKHOUSE_URL)(
  'retains ambiguity for a native missing materialized-view destination',
  async () => {
    const ch = createClickHouseClient();
    const suffix = randomUUID().replaceAll('-', '');
    const source = `qa_ingest_source_${suffix}`,
      target = `qa_ingest_target_${suffix}`,
      view = `qa_ingest_view_${suffix}`;
    let code = '',
      message = '';
    try {
      await ch.command({ query: `CREATE TABLE ${source} AS events ENGINE=MergeTree ORDER BY(project_id,timestamp,event_id)` });
      await ch.command({ query: `CREATE TABLE ${target}(project_id String,event_id String) ENGINE=MergeTree ORDER BY(project_id,event_id)` });
      await ch.command({ query: `CREATE MATERIALIZED VIEW ${view} TO ${target} AS SELECT project_id,event_id FROM ${source}` });
      await ch.command({ query: `DROP TABLE ${target} SYNC` });
      const native = ch.exec.bind(ch);
      ch.exec = async (params) => {
        try {
          return await native({ ...params, query: params.query.replace('INTO events ', `INTO ${source} `) });
        } catch (error) {
          code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          message = error instanceof Error ? error.message : String(error);
          throw error;
        }
      };
      const row = normalizeEvent({ id: 'native-view-target', action: 'qa.view.target' }, { projectId: `qa-${suffix}`, receivedAt: new Date() });
      if (!row.ok) throw new Error(row.reason);
      await expect(insertEvents(ch, [row.row])).rejects.toBeInstanceOf(AmbiguousInsertError);
      expect(code).toBe('60');
      expect(message).toMatch(/^Target table .+ of view /);
    } finally {
      await ch.command({ query: `DROP VIEW IF EXISTS ${view} SYNC` });
      await ch.command({ query: `DROP TABLE IF EXISTS ${target} SYNC` });
      await ch.command({ query: `DROP TABLE IF EXISTS ${source} SYNC` });
      await ch.close();
    }
  },
  30_000,
);

it.runIf(process.env.CLICKHOUSE_URL)(
  'delivers repeated 1000-row byte bodies over native keepalive without a socket timeout',
  async () => {
    const ch = createClickHouseClient(),
      suffix = randomUUID().replaceAll('-', ''),
      table = `qa_ingest_body_${suffix}`;
    const exec = ch.exec.bind(ch);
    ch.exec = (params) => exec({ ...params, query: params.query.replace('INTO events ', `INTO ${table} `) });
    const failures: string[] = [];
    try {
      await ch.command({ query: `CREATE TABLE ${table} AS events ENGINE=MergeTree ORDER BY(project_id,timestamp,event_id)` });
      for (let batch = 0; batch < 20; batch++) {
        const receivedAt = new Date();
        const rows = Array.from({ length: 1000 }, (_, i) => {
          const n = normalizeEvent(
            { id: `${batch}-${i}`, action: 'qa.byte.body', metadata: { content: 'x'.repeat(4096) } },
            { projectId: `qa-body-${suffix}`, receivedAt },
          );
          if (!n.ok) throw new Error(n.reason);
          return n.row;
        });
        try {
          await insertEvents(ch, rows);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
          throw error;
        }
      }
      const rows = await (await ch.query({ query: `SELECT count() n,uniqExact(event_id) ids FROM ${table}`, format: 'JSONEachRow' })).json<{
        n: number;
        ids: number;
      }>();
      expect(rows).toEqual([{ n: 20_000, ids: 20_000 }]);
      expect(failures).toEqual([]);
    } finally {
      await ch.command({ query: `DROP TABLE IF EXISTS ${table} SYNC` });
      await ch.close();
    }
  },
  60_000,
);

it.runIf(process.env.CLICKHOUSE_URL)(
  'keeps a real async acknowledgement timeout ambiguous until the queued byte body arrives',
  async () => {
    const ch = createClickHouseClient(),
      table = `qa_ingest_queued_${randomUUID().replaceAll('-', '')}`;
    const exec = ch.exec.bind(ch);
    let code = '';
    ch.exec = async (params) => {
      try {
        return await exec({
          ...params,
          query: params.query.replace('INTO events ', `INTO ${table} `),
          clickhouse_settings: {
            ...params.clickhouse_settings,
            async_insert_use_adaptive_busy_timeout: 0,
            async_insert_busy_timeout_min_ms: 5000,
            async_insert_busy_timeout_max_ms: 5000,
            wait_for_async_insert_timeout: 1,
          },
        });
      } catch (error) {
        code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        throw error;
      }
    };
    try {
      await ch.command({ query: `CREATE TABLE ${table} AS events ENGINE=MergeTree ORDER BY(project_id,timestamp,event_id)` });
      const n = normalizeEvent({ id: 'queued-byte-body', action: 'qa.queued' }, { projectId: 'fictional', receivedAt: new Date() });
      if (!n.ok) throw new Error(n.reason);
      await expect(insertEvents(ch, [n.row])).rejects.toBeInstanceOf(AmbiguousInsertError);
      expect(code).toBe('159');
      const count = async () =>
        Number((await (await ch.query({ query: `SELECT count() n FROM ${table}`, format: 'JSONEachRow' })).json<{ n: number }>())[0]?.n);
      expect(await count()).toBe(0);
      await ch.command({ query: 'SYSTEM FLUSH ASYNC INSERT QUEUE' });
      expect(await count()).toBe(1);
    } finally {
      await ch.command({ query: `DROP TABLE IF EXISTS ${table} SYNC` });
      await ch.close();
    }
  },
  30_000,
);
