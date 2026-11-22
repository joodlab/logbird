import { randomUUID } from 'node:crypto';
import { searchResponseSchema } from '@logbird/contracts';
import { expect, it, vi } from 'vitest';
import type { ClickHouseClient } from './client';
import { createClickHouseClient, insertEvents, normalizeEvent, purgeProject, searchEvents } from './index';

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
