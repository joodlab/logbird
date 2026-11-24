import { randomUUID } from 'node:crypto';
import { facetResponseSchema, searchResponseSchema } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { ACTOR_NAME_IS_SENSITIVE_SQL, ACTOR_NAME_MASK_PARAMS, actorNameIsSensitive, maskedEmail } from './actor-name-mask';
import { compileMaskedQuery, maskEvent } from './field-mask';
import { createClickHouseClient, facets, insertEvents, normalizeEvent, purgeProject, searchEvents, WEBHOOK_FILTER } from './index';

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
        // Padded past the 512-unit name cap: stored cut, still the address.
        {
          id: 'erin',
          action: 'booking.noted',
          description: 'plain',
          actor: { id: 'u5', name: `erin${' '.repeat(600)}@example.com`, email: 'erin@example.com' },
          tenant,
        },
        // Round 2: the address inside the name; an address only as the name; the email (not the name) cut at its cap.
        {
          id: 'frank',
          action: 'booking.noted',
          description: 'plain',
          actor: { id: 'u6', name: 'Frank <frank@example.com>', email: 'frank@example.com' },
          tenant,
        },
        { id: 'gina', action: 'booking.noted', description: 'plain', actor: { id: 'u7', name: 'gina@contact.example' }, tenant },
        {
          id: 'hal',
          action: 'booking.noted',
          description: 'plain',
          actor: { id: 'u8', name: 'hal@example.org', email: `hal${' '.repeat(600)}@example.org` },
          tenant,
        },
      ];
      const normalized = inputs.map((e, i) => normalizeEvent({ ...e, occurredAt: at(10_000 - i * 100) }, { projectId: p, receivedAt: now }));
      // Every fixture must normalise: a dropped one would let the probes below pass on a missing row.
      expect(normalized.map((r) => r.ok)).toEqual(inputs.map(() => true));
      await insertEvents(
        ch,
        normalized.flatMap((r) => (r.ok ? [r.row] : [])),
      );
      const alice = maskedEmail(p, 'alice@example.com', key);
      const carol = maskedEmail(p, 'carol@example.com', key);
      const dave = maskedEmail(p, 'dave@example.com', key);
      const erin = maskedEmail(p, 'erin@example.com', key);
      // Expected independently of the code under test: the email it contains; the normalised address-only name; the
      // stored email cut at its 512-unit cap.
      const frank = maskedEmail(p, 'frank@example.com', key);
      const gina = maskedEmail(p, 'gina@contact.example', key);
      const hal = maskedEmail(p, `hal${' '.repeat(509)}`, key);

      // The scope's events, masked: the facets below must show exactly these names.
      const events = searchResponseSchema.parse(await searchEvents(ch, p, { ...range, limit: 50, order: 'desc' }, undefined, scope));
      const masked = events.data.map((e) => maskEvent(e, scope.mask, key));
      const expected: Record<string, number> = {};
      for (const e of masked) expected[e.actor?.name ?? ''] = (expected[e.actor?.name ?? ''] ?? 0) + 1;
      expect(JSON.stringify(masked.map((e) => e.actor?.name))).not.toMatch(/@/);
      expect(masked.map((e) => e.id).sort()).toEqual(inputs.map((e) => e.id).sort());
      expect(Object.fromEntries(masked.filter((e) => ['frank', 'gina', 'hal'].includes(e.id)).map((e) => [e.id, e.actor?.name]))).toEqual({
        frank,
        gina,
        hal,
      });

      // field=actor.name: values and labels.
      const byName = facetResponseSchema.parse(await facets(ch, p, { ...range, field: 'actor.name', limit: 20 }, scope, undefined, key));
      expect(Object.fromEntries(byName.values.map((v) => [v.value, v.count]))).toEqual(expected);
      expect(byName.values.map((v) => v.value)).toEqual(expect.arrayContaining([alice, 'Bob', carol, dave, erin, frank, gina, hal]));
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
      ).toEqual(
        masked
          .filter((e) => e.action === 'booking.noted')
          .map((e) => e.actor?.name)
          .sort(),
      );
      // by=actor: the second-level label (a distinct id, so a fallback to the id would show) is the event's pseudonym.
      const actorsByAction = facetResponseSchema.parse(
        await facets(ch, p, { ...range, field: 'action', by: 'actor', limit: 10, byLimit: 10 }, scope, undefined, key),
      );
      const labelsOf = (action: string) =>
        Object.fromEntries(actorsByAction.values.find((v) => v.value === action)?.groups?.map((g) => [g.value, g.label]) ?? []);
      expect(labelsOf('booking.created')).toEqual({ u1: alice, u1b: alice, u2: 'Bob' });
      expect(labelsOf('booking.noted')).toMatchObject({ u3: carol, u4: dave, u5: erin, u6: frank, u7: gina, u8: hal });
      for (const facet of [byName, byActor, byAction, actorsByAction]) expect(JSON.stringify(facet)).not.toMatch(/@/);

      // The pseudonym is the one the same scope's events carry.
      expect(masked.find((e) => e.id === 'alice-1')?.actor?.name).toBe(alice);
      expect(masked.find((e) => e.id === 'alice-2')?.actor?.name).toBe(alice);
      expect(masked.find((e) => e.id === 'erin')?.actor?.name).toBe(erin);

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
      expect(await count('frank@example.com')).toEqual([]);
      expect(await count('actor.name:*frank*')).toEqual([]);
      expect(await count('gina@contact.example')).toEqual([]);
      expect(await count('actor.name:"hal@example.org"')).toEqual([]);
      // Free text before a name term: the shared aliases are referenced before the term that defines them.
      expect(await count('Bob actor.name:"Bob"')).toEqual(['bob']);
      expect(await count('gina actor.name:*')).toEqual([]);
      expect(await count('plain OR actor.name:"Bob"')).toEqual(['bob', 'dave', 'erin', 'frank', 'gina', 'hal']);
      // Webhook discovery and its send-time recheck select with compileMaskedQuery's SQL: the same probes find nothing.
      for (const probe of ['actor.name:"dave@example.com"', 'frank@example.com', 'gina@contact.example']) {
        const compiled = compileMaskedQuery(probe, scope.mask, Date.now(), WEBHOOK_FILTER);
        const [hit] = await (
          await ch.query({
            query: `SELECT count() n FROM events WHERE project_id={wp:String} AND (${compiled.sql})`,
            query_params: { ...compiled.params, wp: p },
            format: 'JSONEachRow',
          })
        ).json<{ n: string }>();
        expect(Number(hit?.n), probe).toBe(0);
      }
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

/**
 * #333, round 1 finding 4 (class B, #365): Node and ClickHouse case-map with their own Unicode tables. This pins
 * today's agreement for the examples below only (case pairs added in Unicode 17 can differ), so a runtime upgrade
 * that breaks one of them fails here instead of silently making event detail and facets disagree.
 */
it.runIf(process.env.CLICKHOUSE_URL)('real ClickHouse: the SQL name rule and lower-casing agree with JavaScript', async () => {
  const ch = createClickHouseClient();
  const pairs: [string, string][] = [
    ['ALICE@EXAMPLE.COM', 'alice@example.com'],
    ['ÉLODIE.ÇA@EXAMPLE.FR', 'élodie.ça@example.fr'],
    ['ΣΟΦΙΑ@EXAMPLE.GR', 'σοφια@example.gr'],
    ['ИВАН@EXAMPLE.RU', 'иван@example.ru'],
    ['İREM@EXAMPLE.TR', 'irem@example.tr'],
    ['IRMAK@EXAMPLE.TR', 'ırmak@example.tr'],
    ['ẞTRAẞE@EXAMPLE.DE', 'ßtraße@example.de'],
    ['STRASSE@EXAMPLE.DE', 'straße@example.de'],
    ['Bob', 'bob@example.com'],
  ];
  try {
    for (const [name, email] of pairs) {
      const [row] = await (
        await ch.query({
          query: `SELECT ${ACTOR_NAME_IS_SENSITIVE_SQL} same, lowerUTF8(actor_email) lowered, lowerUTF8(actor_name) nameLowered FROM (SELECT {n:String} actor_name, {e:String} actor_email)`,
          query_params: { n: name, e: email, ...ACTOR_NAME_MASK_PARAMS },
          format: 'JSONEachRow',
        })
      ).json<{ same: number; lowered: string; nameLowered: string }>();
      expect(Boolean(Number(row?.same)), `${name} / ${email}`).toBe(actorNameIsSensitive(name, email));
      expect(row?.lowered, email).toBe(email.toLowerCase());
      expect(row?.nameLowered, name).toBe(name.toLowerCase());
    }
  } finally {
    await ch.close();
  }
});
