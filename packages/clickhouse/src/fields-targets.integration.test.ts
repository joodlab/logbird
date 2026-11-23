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
    const range = { from: new Date(now.getTime() - 3_600_000).toISOString(), to: new Date(now.getTime() + 1000).toISOString() };
    try {
      const inputs = [
        {
          id: 'with',
          action: 'booking.updated',
          targets: [
            { type: 'booking', id: 'bk_1042' },
            { type: 'hotel', id: 'h_7' },
          ],
        },
        { id: 'without', action: 'session.started' },
      ];
      const rows = inputs.map((e, i) =>
        normalizeEvent({ ...e, occurredAt: new Date(now.getTime() - 10_000 + i).toISOString() }, { projectId: p, receivedAt: now }),
      );
      await insertEvents(
        ch,
        rows.flatMap((r) => (r.ok ? [r.row] : [])),
      );

      const fields = fieldsResponseSchema.parse(await listFields(ch, p, range));
      const target = fields.data.find((f) => f.key === 'target');
      expect(target).toMatchObject({ kind: 'core', coverage: 0.5, distinctApprox: 2, lastSeen: expect.any(String) });
      expect([...(target?.samples ?? [])].sort()).toEqual(['bk_1042', 'h_7']);
      // Only `target` among the array columns: no rows for target.type, target.name or changes.field.
      expect(fields.data.filter((f) => ['target.type', 'target.name', 'changes.field'].includes(f.key))).toEqual([]);

      // The Fields page's "find events" link (`target:*`) matches the same event the coverage counts.
      const presence = compileQuery('target:*');
      const found = await read<{ event_id: string }>(ch, `SELECT event_id FROM events WHERE project_id={p:String} AND (${presence.sql})`, {
        ...presence.params,
        p,
      });
      expect(found.map((r) => r.event_id)).toEqual(['with']);
    } finally {
      await purgeProject(ch, p);
      await ch.close();
    }
  },
  120_000,
);
