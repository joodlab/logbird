import { randomUUID } from 'node:crypto';
import { facetResponseSchema, searchResponseSchema } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { createClickHouseClient, facets, insertEvents, normalizeEvent, purgeProject, searchEvents } from './index';

/**
 * The console labels the actor and executor facets' empty-id bucket "No actor ID" / "No executor ID" (#333) and filters
 * it with `actor:""` / `executor:""`. That filter must match exactly the events the bucket counted.
 */
it.runIf(process.env.CLICKHOUSE_URL)(
  'real ClickHouse: the empty-id facet bucket and its `field:""` filter count the same events',
  async () => {
    const ch = createClickHouseClient();
    const p = `test-facet-empty-id-${randomUUID()}`;
    const now = new Date();
    const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
    const range = { from: at(3_600_000), to: new Date(now.getTime() + 1000).toISOString() };
    try {
      const inputs = [
        { id: 'with-ids', action: 'booking.created', actor: { type: 'user', id: 'usr_1', name: 'Lina' }, executor: { type: 'worker', id: 'wrk_1' } },
        {
          id: 'email-only',
          action: 'booking.noted',
          actor: { email: 'guest@example.invalid' },
          executor: { type: 'worker', name: 'Billing worker' },
        },
        { id: 'name-only', action: 'booking.noted', actor: { name: 'Front desk' } },
        { id: 'type-only', action: 'booking.noted', actor: { type: 'system' } },
        { id: 'no-party', action: 'booking.noted' },
      ];
      const rows = inputs.map((e, i) => normalizeEvent({ ...e, occurredAt: at(10_000 - i * 100) }, { projectId: p, receivedAt: now }));
      await insertEvents(
        ch,
        rows.flatMap((r) => (r.ok ? [r.row] : [])),
      );

      for (const [field, expected] of [
        ['actor', 4],
        ['executor', 4],
      ] as const) {
        const facet = facetResponseSchema.parse(await facets(ch, p, { ...range, field, limit: 10 }));
        const bucket = facet.values.find((v) => v.value === '');
        expect(bucket?.count, `${field} empty-id bucket`).toBe(expected);
        const search = searchResponseSchema.parse(await searchEvents(ch, p, { ...range, q: `${field}:""`, limit: 50, order: 'desc' }));
        expect(search.data.length, `${field}:"" search`).toBe(expected);
        expect(search.data.every((e) => (field === 'actor' ? !e.actor?.id : !e.executor?.id))).toBe(true);
      }
    } finally {
      await purgeProject(ch, p);
      await ch.close();
    }
  },
  120_000,
);
