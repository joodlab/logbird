import { randomUUID } from 'node:crypto';
import { facetResponseSchema, searchResponseSchema } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { maskedEmail } from './actor-name-mask';
import { maskEvent } from './field-mask';
import { createClickHouseClient, facets, insertEvents, normalizeEvent, purgeProject, searchEvents } from './index';

/**
 * #333 on real ClickHouse: under the actor_email mask, a name that is the address shows only as the pseudonym the
 * scope's events carry (case and whitespace variants of one address group together), and no filter can probe it.
 */
it.runIf(process.env.CLICKHOUSE_URL)(
  'real ClickHouse: masked facets show a name that is the address as its pseudonym and filters cannot probe it',
  async () => {
    const ch = createClickHouseClient();
    const p = `test-facet-name-mask-${randomUUID()}`;
    const key = Buffer.alloc(32, 9);
    const scope = { tenantId: 'acme', mask: ['actor_email' as const] };
    const now = new Date();
    const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
    const range = { from: at(3_600_000), to: new Date(now.getTime() + 1000).toISOString() };
    const tenant = { id: 'acme' };
    try {
      const inputs = [
        { id: 'alice-1', action: 'booking.created', actor: { id: 'u1', name: 'Alice@Example.com', email: 'alice@example.com' }, tenant },
        { id: 'alice-2', action: 'booking.created', actor: { id: 'u1b', name: ' alice@example.com\t', email: 'ALICE@example.com' }, tenant },
        { id: 'bob', action: 'booking.created', actor: { id: 'u2', name: 'Bob', email: 'bob@example.com' }, tenant },
        {
          id: 'carol',
          action: 'booking.noted',
          description: 'note mentions carol@example.com',
          actor: { id: 'u3', name: 'carol@example.com', email: 'carol@example.com' },
          tenant,
        },
        {
          id: 'dave',
          action: 'booking.noted',
          description: 'plain',
          actor: { id: 'u4', name: 'dave@example.com', email: 'dave@example.com' },
          tenant,
        },
      ];
      const normalized = inputs.map((e, i) => normalizeEvent({ ...e, occurredAt: at(10_000 - i * 100) }, { projectId: p, receivedAt: now }));
      await insertEvents(
        ch,
        normalized.flatMap((r) => (r.ok ? [r.row] : [])),
      );
      const alice = maskedEmail(p, 'alice@example.com', key);
      const carol = maskedEmail(p, 'carol@example.com', key);
      const dave = maskedEmail(p, 'dave@example.com', key);

      // field=actor.name: values and labels.
      const byName = facetResponseSchema.parse(await facets(ch, p, { ...range, field: 'actor.name', limit: 10 }, scope, undefined, key));
      expect(Object.fromEntries(byName.values.map((v) => [v.value, v.count]))).toEqual({ [alice]: 2, Bob: 1, [carol]: 1, [dave]: 1 });
      expect(byName.values.every((v) => v.label === v.value)).toBe(true);
      // field=actor: the label at the first level; by=actor.name at the second.
      const byActor = facetResponseSchema.parse(
        await facets(ch, p, { ...range, field: 'actor', by: 'actor.name', limit: 10 }, scope, undefined, key),
      );
      expect(byActor.values.find((v) => v.value === 'u1')?.label).toBe(alice);
      expect(byActor.values.find((v) => v.value === 'u2')?.label).toBe('Bob');
      expect(byActor.values.find((v) => v.value === 'u1')?.groups?.map((g) => [g.value, g.label])).toEqual([[alice, alice]]);
      const byAction = facetResponseSchema.parse(
        await facets(ch, p, { ...range, field: 'action', by: 'actor.name', limit: 10, byLimit: 10 }, scope, undefined, key),
      );
      expect(
        byAction.values
          .find((v) => v.value === 'booking.noted')
          ?.groups?.map((g) => g.label)
          .sort(),
      ).toEqual([carol, dave].sort());
      for (const facet of [byName, byActor, byAction]) expect(JSON.stringify(facet)).not.toMatch(/@/);

      // The pseudonym is the one the same scope's events carry.
      const events = searchResponseSchema.parse(await searchEvents(ch, p, { ...range, limit: 50, order: 'desc' }, undefined, scope));
      const masked = events.data.map((e) => maskEvent(e, scope.mask, key));
      expect(masked.find((e) => e.id === 'alice-1')?.actor?.name).toBe(alice);
      expect(masked.find((e) => e.id === 'alice-2')?.actor?.name).toBe(alice);

      // Filters cannot probe the address through the name, and match free text only through the other text.
      const count = async (q: string) =>
        searchResponseSchema
          .parse(await searchEvents(ch, p, { ...range, q, limit: 50, order: 'desc' }, undefined, scope))
          .data.map((e) => e.id)
          .sort();
      expect(await count('actor.name:"dave@example.com"')).toEqual([]);
      expect(await count('actor.name:dave*')).toEqual([]);
      expect(await count('actor.name:"Bob"')).toEqual(['bob']);
      expect(await count('dave@example.com')).toEqual([]);
      expect(await count('carol@example.com')).toEqual(['carol']);
      // Without the mask, the same probes see the names (the rewrite applies to masked scopes only).
      const unmasked = searchResponseSchema.parse(
        await searchEvents(ch, p, { ...range, q: 'actor.name:"dave@example.com"', limit: 50, order: 'desc' }, undefined, { tenantId: 'acme' }),
      );
      expect(unmasked.data.map((e) => e.id)).toEqual(['dave']);
    } finally {
      await purgeProject(ch, p);
      await ch.close();
    }
  },
  120_000,
);
