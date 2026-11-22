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
      // Events arriving close to their event time, as live traffic does: 50k rows over ten days in one insert,
      // so the project's part holds several granules with distinct arrival ranges.
      const now = Date.now();
      const count = 50_000;
      const rows = Array.from({ length: count }, (_, i) => {
        const at = now - Math.floor((i / count) * 10 * 86_400_000);
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
            // Interpretable EXPLAIN counts: no condition cache, no skip-index use at read time.
            clickhouse_settings: { use_query_condition_cache: 0, use_skip_indexes_on_data_read: 0 },
          })
        ).json<{ explain: string }>()
      ).map((r) => r.explain);
      const at = plan.findIndex((line) => line.includes('Name: idx_received_at'));
      expect(at).toBeGreaterThan(-1);
      // The index step's own block: lines after its Name up to the next index or step.
      const block: string[] = [];
      for (const line of plan.slice(at + 1)) {
        if (/Name:|^\s*\w+ \(/.test(line)) break;
        block.push(line);
      }
      const granules = block.map((line) => /Granules: (\d+)\/(\d+)/.exec(line)).find(Boolean);
      expect(granules).toBeTruthy();
      const [kept, total] = [Number(granules?.[1]), Number(granules?.[2])];
      // The fixture spans ten days in several granules; a 6-minute slice must skip some of them.
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(total);
    } finally {
      await purgeProject(ch, p);
      await ch.close();
    }
  },
  120_000,
);
