import { randomUUID } from 'node:crypto';
import { facetResponseSchema, suggestResponseSchema } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { createClickHouseClient, insertEvents } from './client';
import { normalizeEvent } from './normalize';
import { facets, purgeProject, searchEvents } from './queries';
import { suggestValues } from './suggest';

it.runIf(process.env.CLICKHOUSE_URL)(
  'finds support agents by name: impersonator facet and suggestions carry display names',
  async () => {
    const ch = createClickHouseClient(),
      p = `impersonation-${randomUUID()}`,
      now = new Date(),
      from = new Date(now.getTime() - 60_000).toISOString(),
      to = new Date(now.getTime() + 1000).toISOString();
    const customer = { id: 'cust_huda', name: 'Huda Saleh (fictional)', type: 'user' };
    const fixtures = [
      { id: 'a', impersonator: { id: 'support_omar', name: 'Omar Haddad (fictional)' } },
      { id: 'b', impersonator: { id: 'support_omar', name: 'Omar Haddad (fictional)' } },
      { id: 'c', impersonator: { id: 'support_lina', name: 'Lina Park (fictional)' } },
      { id: 'd' },
    ];
    try {
      const rows = fixtures.map((f, i) =>
        normalizeEvent(
          { ...f, action: 'booking.modified', occurredAt: new Date(now.getTime() - (i + 1) * 1000).toISOString(), actor: customer },
          { projectId: p, receivedAt: now },
        ),
      );
      await insertEvents(
        ch,
        rows.flatMap((r) => (r.ok ? [r.row] : [])),
      );

      const facet = facetResponseSchema.parse(await facets(ch, p, { from, to, field: 'impersonator', limit: 10 }));
      // Events without an impersonator form the '' bucket; the "Done by support" filter hides it.
      expect(facet.values.filter((v) => v.value !== '')).toEqual([
        { value: 'support_omar', label: 'Omar Haddad (fictional)', count: 2 },
        { value: 'support_lina', label: 'Lina Park (fictional)', count: 1 },
      ]);
      expect(facet.values.find((v) => v.value === '')?.count).toBe(1);

      // Scoped to one customer: "support acting as Huda" vs "Huda herself".
      const asCustomer = await facets(ch, p, { from, to, q: 'actor:cust_huda', field: 'impersonator', limit: 10 });
      expect(asCustomer.values.filter((v) => v.value !== '').reduce((n, v) => n + v.count, 0)).toBe(3);
      expect((await searchEvents(ch, p, { from, to, q: 'actor:cust_huda -impersonator:*', limit: 10, order: 'desc' })).total).toBe(1);
      expect((await searchEvents(ch, p, { from, to, q: 'actor:cust_huda impersonator:*', limit: 10, order: 'desc' })).total).toBe(3);

      // The query bar and jump-to match a fragment of the agent's name, not only the id.
      const byName = suggestResponseSchema.parse(await suggestValues(ch, p, { field: 'impersonator', prefix: 'omar', limit: 10 }));
      expect(byName.values).toEqual([{ value: 'support_omar', label: 'Omar Haddad (fictional)', count: 2 }]);
      const all = await suggestValues(ch, p, { field: 'impersonator', limit: 10 });
      expect(all.values.map((v) => v.label)).toEqual(['Omar Haddad (fictional)', 'Lina Park (fictional)']);
    } finally {
      await purgeProject(ch, p);
      await ch.close();
    }
  },
  60_000,
);
