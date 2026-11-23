import { randomUUID } from 'node:crypto';
import { fieldsResponseSchema } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { compileQuery, createClickHouseClient, insertEvents, listFields, normalizeEvent, purgeProject, read } from './index';

it.runIf(process.env.CLICKHOUSE_URL)(
  'real ClickHouse: Fields reports targets coverage, counting exactly the events target:* finds',
  async () => {
    const ch = createClickHouseClient();
    const p = `test-fields-targets-${randomUUID()}`;
    const now = new Date();
    const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
    const range = { from: at(3_600_000), to: new Date(now.getTime() + 1000).toISOString() };
    try {
      const inputs = [
        // Two targets with ids.
        {
          id: 'with',
          action: 'booking.updated',
          occurredAt: at(40_000),
          targets: [
            { type: 'booking', id: 'bk_1042' },
            { type: 'hotel', id: 'h_7' },
          ],
        },
        // A mixed array: one id-less target and one with an id. It counts, and its time is the latest match.
        { id: 'mixed', action: 'booking.moved', occurredAt: at(30_000), targets: [{ type: 'room' }, { type: 'booking', id: 'bk_2001' }] },
        // Newer, but its only target has no id: it does not count, and must not move lastSeen.
        { id: 'idless', action: 'room.viewed', occurredAt: at(20_000), targets: [{ type: 'room' }] },
        // No targets at all.
        { id: 'without', action: 'session.started', occurredAt: at(10_000) },
      ];
      const rows = inputs.map((e) => normalizeEvent(e, { projectId: p, receivedAt: now }));
      await insertEvents(
        ch,
        rows.flatMap((r) => (r.ok ? [r.row] : [])),
      );

      const fields = fieldsResponseSchema.parse(await listFields(ch, p, range));
      const target = fields.data.find((f) => f.key === 'target');
      expect(target).toMatchObject({ kind: 'core', coverage: 0.5, distinctApprox: 3 });
      expect([...(target?.samples ?? [])].sort()).toEqual(['bk_1042', 'bk_2001', 'h_7']);
      expect(Date.parse(target?.lastSeen ?? '')).toBe(Date.parse(at(30_000)));
      // Only `target` among the array columns: no rows for target.type, target.name or changes.field.
      expect(fields.data.filter((f) => ['target.type', 'target.name', 'changes.field'].includes(f.key))).toEqual([]);

      // The Fields page's "find events" link (`target:*`) matches the same events the coverage counts.
      const presence = compileQuery('target:*');
      const found = await read<{ event_id: string }>(
        ch,
        `SELECT event_id FROM events WHERE project_id={p:String} AND (${presence.sql}) ORDER BY event_id`,
        { ...presence.params, p },
      );
      expect(found.map((r) => r.event_id)).toEqual(['mixed', 'with']);

      // A range holding only the id-less event: no coverage, and no last time.
      const idlessOnly = fieldsResponseSchema.parse(await listFields(ch, p, { from: at(25_000), to: at(15_000) }));
      expect(idlessOnly.data.find((f) => f.key === 'target')).toMatchObject({ coverage: 0, distinctApprox: 0, samples: [], lastSeen: null });
    } finally {
      await purgeProject(ch, p);
      await ch.close();
    }
  },
  120_000,
);
