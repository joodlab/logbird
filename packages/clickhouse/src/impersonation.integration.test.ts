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
      { id: 'b', outcome: 'failure', impersonator: { id: 'support_omar', name: 'Omar Haddad (fictional)' } },
      { id: 'c', outcome: 'denied', impersonator: { id: 'support_lina', name: 'Lina Park (fictional)' } },
      { id: 'd', outcome: 'denied' },
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

      // The agent page's timeline: andQuery('impersonator:support_omar', 'outcome:failure OR outcome:denied') parenthesises
      // the user's OR, so only Omar's events come back. Unparenthesised, AND binds tighter and every denied event leaks in.
      const agentOr = await searchEvents(ch, p, {
        from,
        to,
        q: 'impersonator:support_omar (outcome:failure OR outcome:denied)',
        limit: 10,
        order: 'desc',
      });
      expect(agentOr.total).toBe(1);
      expect(agentOr.data.map((e) => e.impersonator?.id)).toEqual(['support_omar']);
      expect(
        (await searchEvents(ch, p, { from, to, q: 'impersonator:support_omar outcome:failure OR outcome:denied', limit: 10, order: 'desc' })).total,
      ).toBe(3);
      // The sidebar's presence count over a user OR: withPresence → '(…OR…) impersonator:*' excludes the empty bucket.
      const anyOr = await facets(ch, p, { from, to, q: '(outcome:failure OR outcome:denied) impersonator:*', field: 'impersonator', limit: 1 });
      expect(anyOr.values.reduce((n, v) => n + v.count, 0) + anyOr.otherCount).toBe(2);

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

it.runIf(process.env.CLICKHOUSE_URL)(
  'support counts and agent lists stay exact on a busy project: empty buckets, >20 agents, >50k newer rows',
  async () => {
    const ch = createClickHouseClient(),
      p = `impersonation-busy-${randomUUID()}`,
      now = Date.now(),
      at = (msAgo: number) => new Date(now - msAgo).toISOString(),
      from = at(3 * 3_600_000),
      to = at(-1000);
    const customer = { id: 'cust_rania', name: 'Rania Qasim (fictional)', type: 'user' };
    const events: Record<string, unknown>[] = [];
    // 22 agents, the oldest events in range (two hours ago): 22 x 3 = 66 support events.
    for (let a = 0; a < 22; a++)
      for (let i = 0; i < 3; i++)
        events.push({
          action: 'booking.modified',
          occurredAt: at(2 * 3_600_000 + a * 1000 + i),
          actor: customer,
          tenant: { id: 'tenant_north', name: 'North (fictional)' },
          impersonator: { id: `support_${String(a).padStart(2, '0')}`, name: `Agent ${a} (fictional)` },
        });
    // Support events without an actor or tenant: they must not count as a customer or tenant.
    events.push({ action: 'booking.viewed', occurredAt: at(2 * 3_600_000 - 5000), impersonator: { id: 'support_00', name: 'Agent 0 (fictional)' } });
    // One event the customer did themselves: the low-frequency empty bucket.
    events.push({ action: 'booking.viewed', occurredAt: at(2 * 3_600_000 - 6000), actor: customer });
    // 50,500 newer events nobody impersonated (other actors), so a 50k "latest rows" sample sees no agent.
    for (let i = 0; i < 50_500; i++)
      events.push({ action: 'page.viewed', occurredAt: at(3_600_000 - i * 10), actor: { id: `cust_${i % 97}`, type: 'user' } });
    try {
      const rows = events.map((e) => normalizeEvent(e, { projectId: p, receivedAt: new Date(now) }));
      const ok = rows.flatMap((r) => (r.ok ? [r.row] : []));
      for (let i = 0; i < ok.length; i += 10_000) await insertEvents(ch, ok.slice(i, i + 10_000));

      // the agent lookup sees agents behind 50k newer rows.
      const suggestions = suggestResponseSchema.parse(await suggestValues(ch, p, { field: 'impersonator', prefix: 'agent 21', limit: 5, from, to }));
      expect(suggestions.values.map((v) => v.value)).toEqual(['support_21']);
      const all = await suggestValues(ch, p, { field: 'impersonator', limit: 50, from, to });
      expect(all.values).toHaveLength(22);
      expect(all.complete).toBe(true);

      // The facet is bounded in SQL and otherCount stays exact: 22 agents, limit 20.
      const facet = facetResponseSchema.parse(await facets(ch, p, { from, to, q: 'impersonator:*', field: 'impersonator', limit: 20 }));
      expect(facet.values).toHaveLength(20);
      expect(facet.values.some((v) => v.value === '')).toBe(false);
      expect(facet.values.reduce((n, v) => n + v.count, 0) + facet.otherCount).toBe(67);

      // the customer's split. Without the presence predicate the empty bucket (1 event) would be outside the top 20.
      const asCustomer = facetResponseSchema.parse(
        await facets(ch, p, { from, to, q: 'actor:cust_rania impersonator:*', field: 'impersonator', limit: 20 }),
      );
      expect(asCustomer.values.reduce((n, v) => n + v.count, 0) + asCustomer.otherCount).toBe(66);
      expect((await searchEvents(ch, p, { from, to, q: 'actor:cust_rania -impersonator:*', limit: 10, order: 'desc' })).total).toBe(1);

      // The agent page: customers and tenants acted as exclude events with no actor or tenant.
      const actedAs = await facets(ch, p, { from, to, q: 'impersonator:support_00 actor:*', field: 'actor', limit: 100 });
      expect(actedAs.values).toEqual([{ value: 'cust_rania', label: 'Rania Qasim (fictional)', count: 3 }]);
      expect(actedAs.otherCount).toBe(0);
      const tenants = await facets(ch, p, { from, to, q: 'impersonator:support_00 tenant:*', field: 'tenant', limit: 100 });
      expect(tenants.values.map((v) => v.value)).toEqual(['tenant_north']);
      // Ordinary facets keep their empty bucket.
      const withEmpty = await facets(ch, p, { from, to, q: 'impersonator:support_00', field: 'actor', limit: 100 });
      expect(withEmpty.values.find((v) => v.value === '')?.count).toBe(1);
    } finally {
      await purgeProject(ch, p);
      await ch.close();
    }
  },
  180_000,
);
