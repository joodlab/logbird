import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createClickHouseClient, insertEvents } from './client';
import { normalizeEvent } from './normalize';
import { searchEvents } from './queries';
import { suggestValues } from './suggest';

it.runIf(process.env.CLICKHOUSE_URL)('executes v2 filters and parameterized values on real ClickHouse', async () => {
  const ch = createClickHouseClient(),
    projectId = `search-language-${randomUUID()}`,
    now = new Date();
  try {
    for (const [id, attempt, duration] of [
      ['one', 3, '200'],
      ['two', 1, 'invalid'],
    ] as const) {
      const r = normalizeEvent(
        {
          id,
          action: 'booking.created',
          occurredAt: now.toISOString(),
          actor: { id: 'usr_42' },
          executor: { attempt },
          targets: [{ type: 'booking', id: 'bk_1', name: 'Booking One' }],
          metadata: { duration, day: '2026-11-01' },
          description: 'Fictional record',
        },
        { projectId, receivedAt: now },
      );
      if (!r.ok) throw new Error('fixture');
      await insertEvents(ch, [r.row]);
    }
    const q = {
      from: new Date(now.getTime() - 1000).toISOString(),
      to: new Date(now.getTime() + 1000).toISOString(),
      limit: 50,
      order: 'desc' as const,
    };
    for (const [filter, expected] of [
      ['attempt:>2', 1],
      ['_exists_:actor', 2],
      ['NOT _exists_:actor', 0],
      ['occurredAt:[now-24h TO now+1h]', 2],
      ['attempt:[1 TO 3}', 1],
      ['metadata.duration:[100 TO 500]', 1],
      ['metadata.duration:{200 TO *]', 0],
      ['metadata.day:>=2026-11-01', 2],
      ['attributes.metadata.duration:200', 1],
      ['action:/booking\\.created/', 2],
      ['target.name:/Booking.*/', 2],
      ['actor.id:usr_42 AND NOT attempt:>2', 1],
      ['action:(booking.created OR other)', 2],
      ['-action:(booking.created OR other)', 0],
      ['target:(missing OR bk_*)', 2],
      ['occurredAt:>2026-01-01T12:00:00Z', 2],
      ['metadata.unknown:"x\' OR 1=1 --"', 0],
    ] as const) {
      const r = await searchEvents(ch, projectId, { ...q, q: filter });
      expect(r.data.length, filter).toBe(expected);
    }
    const suggestions = await suggestValues(ch, projectId, { ...q, field: 'metadata.duration', limit: 10, q: 'attempt:>2' });
    expect(suggestions).toMatchObject({ complete: true, values: [{ value: '200', count: 1 }] });
    expect((await suggestValues(ch, projectId, { field: 'metadata.duration', limit: 1 })).complete).toBe(false);
  } finally {
    await ch.close();
  }
});
