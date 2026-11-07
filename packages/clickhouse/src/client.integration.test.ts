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
      const native = ch.insert.bind(ch);
      ch.insert = async (params) => {
        try {
          return await native({ ...params, table: source });
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
