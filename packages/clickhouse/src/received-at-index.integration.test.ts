import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createClickHouseClient, insertEvents, normalizeEvent, purgeProject } from './index';

it.runIf(process.env.CLICKHOUSE_URL)(
  'real ClickHouse: arrival-time slices use idx_received_at to skip granules',
  async () => {
    const ch = createClickHouseClient();
    const p = `test-received-${randomUUID()}`;
    try {
      const indices = await (
        await ch.query({
          query:
            "SELECT type, expr FROM system.data_skipping_indices WHERE database = currentDatabase() AND table = 'events' AND name = 'idx_received_at'",
          format: 'JSONEachRow',
        })
      ).json<{ type: string; expr: string }>();
      expect(indices).toEqual([{ type: 'minmax', expr: 'received_at' }]);
      // A year of events arriving close to their event time, as live traffic does.
      const now = Date.now();
      const rows = Array.from({ length: 20_000 }, (_, i) => {
        const at = now - Math.floor((i / 20_000) * 365 * 86_400_000);
        const n = normalizeEvent(
          { id: `r${i}`, action: 'qa.arrival', occurredAt: new Date(at).toISOString() },
          { projectId: p, receivedAt: new Date(at + 1000) },
        );
        if (!n.ok) throw new Error(n.reason);
        return n.row;
      });
      await insertEvents(ch, rows);
      const from = new Date(now - 300_000).toISOString().replace('T', ' ').slice(0, -1);
      const to = new Date(now + 60_000).toISOString().replace('T', ' ').slice(0, -1);
      const plan = (
        await (
          await ch.query({
            query:
              "EXPLAIN indexes = 1 SELECT event_id FROM events WHERE project_id = {p:String} AND received_at >= {from:DateTime64(3,'UTC')} AND received_at < {to:DateTime64(3,'UTC')}",
            query_params: { p, from, to },
            format: 'JSONEachRow',
          })
        ).json<{ explain: string }>()
      ).map((r) => r.explain);
      const at = plan.findIndex((line) => line.includes('Name: idx_received_at'));
      expect(at).toBeGreaterThan(-1);
      // The step after the index name reports how many granules it kept.
      const kept = plan.slice(at).find((line) => line.includes('Granules:'));
      expect(kept).toMatch(/Granules: \d+\/\d+/);
    } finally {
      await purgeProject(ch, p);
      await ch.close();
    }
  },
  120_000,
);
