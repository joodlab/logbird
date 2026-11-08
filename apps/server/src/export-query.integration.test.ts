import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { read } from '@logbird/clickhouse';
import { expect, it, vi } from 'vitest';
import { cancelExportQuery, clickhouse } from './clickhouse';

it('cancels its generated ClickHouse query id and waits for confirmed query termination', async () => {
  // Synthetic numbers only: no insert, migration, retained-load-cohort scan or shared setting change.
  // Small blocks keep each synthetic sleep below ClickHouse's per-block sleep limit.
  const project = `qa-export-query-${randomUUID()}`;
  const sql = 'SELECT {project:String} project, sleepEachRow(0.05) paused FROM numbers(200) SETTINGS max_block_size=1';
  const abort = new AbortController();
  let queryId: string | undefined;
  const query = clickhouse.query.bind(clickhouse);
  const spy = vi.spyOn(clickhouse, 'query').mockImplementation((params) => {
    if (params.query === sql) queryId = params.query_id;
    return query(params);
  });
  const pending = read(clickhouse, sql, { project }, 10, true, { signal: abort.signal, cancelQuery: cancelExportQuery });
  const rejected = expect(pending).rejects.toBeTruthy();
  try {
    const running = async () => {
      if (!queryId) return 0;
      const result = await query({
        query: 'SELECT count() n FROM system.processes WHERE query_id={id:String}',
        query_params: { id: queryId },
        format: 'JSONEachRow',
      });
      return (await result.json<{ n: number }>())[0]?.n ?? 0;
    };
    await vi.waitFor(async () => expect(await running()).toBe(1), { timeout: 4000, interval: 20 });
    const started = performance.now();
    abort.abort();
    await rejected;
    expect(await running()).toBe(0);
    const stopMs = performance.now() - started;
    expect(stopMs).toBeLessThan(4000);
    console.log(JSON.stringify({ event: 'qa.export_query_cancel', queryId, stopMs, remaining: 0 }));
    if (process.env.LOGBIRD_EXPORT_PROOF_DIR)
      writeFileSync(
        path.join(process.env.LOGBIRD_EXPORT_PROOF_DIR, 'export-query-metrics.json'),
        JSON.stringify({ queryId, stopMs, remaining: 0 }, null, 2),
      );
  } finally {
    abort.abort();
    await rejected;
    spy.mockRestore();
  }
});
