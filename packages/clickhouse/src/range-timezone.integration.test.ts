import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { ClickHouseClient } from './client';
import { createClickHouseClient, exportEvents, facets, insertEvents, normalizeEvent, purgeProject, searchEvents } from './index';

/** Every statement of this client runs in a non-UTC session, as on a ClickHouse server configured for that zone. */
function inZone(ch: ClickHouseClient, zone: string): ClickHouseClient {
  return new Proxy(ch, {
    get(target, prop, receiver) {
      if (prop === 'query')
        return (args: Parameters<ClickHouseClient['query']>[0]) =>
          target.query({ ...args, clickhouse_settings: { ...args.clickhouse_settings, session_timezone: zone } });
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// The stated window must be the window applied whatever the server's time zone: the bounds, the cursor and the
// export's receive-time fence are UTC instants. Fictional events in their own project, deleted afterwards.
it.runIf(process.env.CLICKHOUSE_URL)(
  'real ClickHouse: a read in a non-UTC session applies exactly the UTC window it states',
  async () => {
    const base = createClickHouseClient();
    const ch = inZone(base, 'Asia/Riyadh');
    const p = `test-range-zone-${randomUUID()}`;
    const hour = 3_600_000;
    const start = Math.floor(Date.now() / hour) * hour - 6 * hour;
    const at = (ms: number) => new Date(start + ms).toISOString();
    const window = { from: at(0), to: at(hour) };
    try {
      const rows = [
        // In the window.
        { id: 'in-1', occurredAt: at(10 * 60_000) },
        { id: 'in-2', occurredAt: at(40 * 60_000) },
        // Inside [from − 3h, to − 3h): what a bound read as Riyadh wall time (UTC+3) would select instead.
        { id: 'shifted', occurredAt: at(-150 * 60_000) },
      ].map((e) => normalizeEvent({ ...e, action: 'qa.zone' }, { projectId: p, receivedAt: new Date(start + 2 * hour) }));
      await insertEvents(
        base,
        rows.flatMap((r) => (r.ok ? [r.row] : [])),
      );

      const page = await searchEvents(ch, p, { ...window, limit: 10, order: 'asc' });
      expect(page.range).toEqual(window);
      expect(page.data.map((e) => e.id)).toEqual(['in-1', 'in-2']);
      expect(page).toMatchObject({ total: 2, totalExact: true });

      const first = await searchEvents(ch, p, { ...window, limit: 1, order: 'asc' });
      const second = await searchEvents(ch, p, { ...window, limit: 1, order: 'asc', cursor: first.nextCursor ?? undefined });
      expect([...first.data, ...second.data].map((e) => e.id)).toEqual(['in-1', 'in-2']);
      expect(second.nextCursor).toBeNull();

      const counted = await facets(ch, p, { ...window, field: 'action', limit: 10 });
      expect(counted.range).toEqual(window);
      expect(counted.values).toEqual([expect.objectContaining({ value: 'qa.zone', count: 2 })]);

      // The export clock is a UTC instant too: one hour after the receipt keeps every row, one hour before keeps none.
      const exported = async (clock: number) => {
        const lines: string[] = [];
        const q = { ...window, format: 'jsonl' as const };
        for await (const line of exportEvents(ch, p, q, { range: window, compiled: { sql: '1', params: {} }, clock: new Date(clock).toISOString() }))
          lines.push((JSON.parse(line) as { id: string }).id);
        return lines;
      };
      expect(await exported(start + 3 * hour)).toEqual(['in-1', 'in-2']);
      expect(await exported(start + hour)).toEqual([]);
    } finally {
      await purgeProject(base, p);
      await base.close();
    }
  },
  180_000,
);
