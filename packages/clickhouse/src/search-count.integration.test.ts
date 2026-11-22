import { randomUUID } from 'node:crypto';
import { searchResponseSchema } from '@logbird/contracts';
import { expect, it, vi } from 'vitest';
import type { ClickHouseClient } from './client';
import { createClickHouseClient, createQueryClickHouseClient, insertEvents, normalizeEvent, purgeProject, read, searchEvents } from './index';

/**
 * Real ClickHouse makes only the total-count statement slow: it sleeps per row past the count's one-second guard,
 * so the server raises a genuine TIMEOUT_EXCEEDED for the count while the row query is untouched.
 */
function slowCount(ch: ClickHouseClient): ClickHouseClient {
  return new Proxy(ch, {
    get(target, prop, receiver) {
      if (prop === 'query')
        return (args: Parameters<ClickHouseClient['query']>[0]) =>
          target.query({
            ...args,
            query: args.query.replace(
              'SELECT DISTINCT event_id FROM events WHERE ',
              'SELECT DISTINCT event_id FROM events WHERE sleepEachRow(0.4) = 0 AND ',
            ),
          });
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

it.runIf(process.env.CLICKHOUSE_URL)(
  'real ClickHouse: a count past its guard never fails or hides the rows',
  async () => {
    const ch = createClickHouseClient();
    const p = `test-count-${randomUUID()}`;
    const now = new Date();
    const range = { from: new Date(now.getTime() - 3_600_000).toISOString(), to: new Date(now.getTime() + 1000).toISOString() };
    try {
      const rows = Array.from({ length: 5 }, (_, i) =>
        normalizeEvent(
          { id: `e${i}`, action: 'qa.count', occurredAt: new Date(now.getTime() - 10_000 + i).toISOString() },
          { projectId: p, receivedAt: now },
        ),
      );
      await insertEvents(
        ch,
        rows.flatMap((r) => (r.ok ? [r.row] : [])),
      );

      const exact = searchResponseSchema.parse(await searchEvents(ch, p, { ...range, limit: 10, order: 'desc' }));
      expect(exact).toMatchObject({ total: 5, totalExact: true });

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const started = Date.now();
      const slow = searchResponseSchema.parse(await searchEvents(slowCount(ch), p, { ...range, limit: 10, order: 'desc' }));
      // The count failed for its time budget (client abort or ClickHouse TIMEOUT_EXCEEDED), not for a broken statement.
      const reasons = warn.mock.calls.map(([line]) => JSON.parse(String(line))).filter((l) => l.event === 'search.count_unavailable');
      expect(reasons.map((l) => l.reason)).toEqual([expect.stringMatching(/^(budget|limit)$/)]);
      warn.mockRestore();
      expect(slow.data.map((e) => e.id)).toEqual(['e4', 'e3', 'e2', 'e1', 'e0']);
      expect(slow).toMatchObject({ total: 5, totalExact: false });
      // The count has a one-second wall-clock budget and runs beside the rows; it cannot hold the page much longer.
      expect(Date.now() - started).toBeLessThan(3000);

      // A partial page: the lower bound is the rows seen plus the one extra row proving there are more.
      const page = searchResponseSchema.parse(await searchEvents(slowCount(ch), p, { ...range, limit: 2, order: 'desc' }));
      expect(page.data).toHaveLength(2);
      expect(page).toMatchObject({ total: 3, totalExact: false });
      expect(page.nextCursor).not.toBeNull();
    } finally {
      await purgeProject(ch, p);
      await ch.close();
    }
  },
  120_000,
);

it.runIf(process.env.CLICKHOUSE_URL)(
  'real ClickHouse: a total at the 10,001 cap is reported as a lower bound',
  async () => {
    const ch = createClickHouseClient();
    const p = `test-count-cap-${randomUUID()}`;
    const now = new Date();
    const range = { from: new Date(now.getTime() - 3_600_000).toISOString(), to: new Date(now.getTime() + 1000).toISOString() };
    try {
      const rows = Array.from({ length: 10_050 }, (_, i) => normalizeEvent({ id: `c${i}`, action: 'qa.cap' }, { projectId: p, receivedAt: now }));
      await insertEvents(
        ch,
        rows.flatMap((r) => (r.ok ? [r.row] : [])),
      );
      const result = searchResponseSchema.parse(await searchEvents(ch, p, { ...range, limit: 1, order: 'desc' }));
      expect(result).toMatchObject({ total: 10_001, totalExact: false });
    } finally {
      await purgeProject(ch, p);
      await ch.close();
    }
  },
  180_000,
);

it.runIf(process.env.CLICKHOUSE_URL && process.env.CLICKHOUSE_QUERY_USER)(
  'real ClickHouse: restricted SQL search returns rows by the count deadline; reports how the server stops the count',
  async () => {
    const ch = createClickHouseClient();
    const qc = createQueryClickHouseClient();
    if (!qc) throw new Error('restricted client not configured');
    const p = `test-count-sql-${randomUUID()}`;
    const marker = `count-marker-${randomUUID()}`;
    const now = new Date();
    const range = { from: new Date(now.getTime() - 3_600_000).toISOString(), to: new Date(now.getTime() + 1000).toISOString() };
    // Patch the instance (not a proxy) so it stays registered as the restricted client.
    const original = qc.query.bind(qc);
    qc.query = ((args: Parameters<ClickHouseClient['query']>[0]) =>
      original({
        ...args,
        query: args.query.replace(
          'SELECT DISTINCT event_id FROM events WHERE ',
          `SELECT DISTINCT event_id FROM events WHERE sleepEachRow(0.5) = 0 AND '${marker}' != '' AND `,
        ),
      })) as ClickHouseClient['query'];
    try {
      const rows = Array.from({ length: 6 }, (_, i) =>
        normalizeEvent(
          { id: `s${i}`, action: 'qa.count', occurredAt: new Date(now.getTime() - 10_000 + i).toISOString() },
          { projectId: p, receivedAt: now },
        ),
      );
      await insertEvents(
        ch,
        rows.flatMap((r) => (r.ok ? [r.row] : [])),
      );
      const started = Date.now();
      const page = await searchEvents(qc, p, { ...range, q: "action = 'qa.count'", lang: 'sql', limit: 10, order: 'desc' });
      const elapsed = Date.now() - started;
      expect(page.data).toHaveLength(6);
      expect(page.totalExact).toBe(false);
      expect(elapsed).toBeLessThan(2500);
      // Server side: wait for the count statement to end and record how. Disconnect cancellation of a readonly
      // statement is cooperative, so the server may finish it; it is bounded by the restricted profile's 10 s.
      let ended: { type: string; exception_code: number; query_duration_ms: number }[] = [];
      for (let attempt = 0; attempt < 30 && !ended.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await ch.command({ query: 'SYSTEM FLUSH LOGS' });
        ended = await read<{ type: string; exception_code: number; query_duration_ms: number }>(
          ch,
          "SELECT toString(type) type, exception_code, query_duration_ms FROM system.query_log WHERE event_time > now() - INTERVAL 5 MINUTE AND type != 'QueryStart' AND user = 'logbird_query' AND positionCaseInsensitive(query, {marker:String}) > 0",
          { marker },
        );
      }
      console.log(JSON.stringify({ event: 'qa.restricted_count_end', elapsedMs: elapsed, server: ended }));
      expect(ended).toHaveLength(1);
      expect(ended[0]?.query_duration_ms).toBeLessThanOrEqual(10_500);
    } finally {
      await purgeProject(ch, p);
      await ch.close();
      await qc.close();
    }
  },
  120_000,
);
