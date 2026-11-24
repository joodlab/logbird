import { describe, expect, it, vi } from 'vitest';
import { ACTOR_NAME_MARKER, actorNameIsEmail, maskActorNameInFilter, maskedEmail } from './actor-name-mask';
import type { ClickHouseClient } from './client';
import { facets } from './queries';
import { compileQuery } from './query';

// #333: under the actor_email mask, a name that is the address must not show or be probed through facets or filters.
describe('the name rule shared by events and SQL', () => {
  it.each([
    ['alice@example.com', 'alice@example.com', true],
    ['Alice@Example.COM', 'alice@example.com', true],
    [' alice@example.com\t', 'alice@example.com', true],
    ['alice @example.com', 'alice@example.com', true],
    ['alice @ example.com', 'alice@example.com', true],
    ['Alice', 'alice@example.com', false],
    ['alice@example.com', '', false],
    ['', '', false],
  ])('%j is the address %j: %s', (name, email, expected) => {
    expect(actorNameIsEmail(name, email)).toBe(expected);
  });
});

describe('the filter rewrite', () => {
  it('reads an empty name wherever the name is the address, so an actor.name probe never matches those rows', () => {
    for (const q of ['actor.name:"carol@example.com"', 'actor.name:carol*', 'actor.name:*', 'NOT actor.name:"x"']) {
      const sql = maskActorNameInFilter(compileQuery(q).sql);
      // Every actor_name reference sits behind the mask expression.
      const unguarded = sql.replaceAll("'',actor_name)", '').replace(/actor_name\),\{actorMaskSpaces/g, '');
      expect(unguarded, q).not.toMatch(/(?<![\w(])actor_name(?![\w)])/);
      expect(sql).toContain("if((actor_email!=''");
    }
  });

  it('matches free text on such a row only through its other text', () => {
    for (const q of ['carol@example.com', 'carol', '"carol example"']) {
      const sql = maskActorNameInFilter(compileQuery(q).sql);
      expect(sql, q).toMatch(/AND \(NOT \(actor_email!=''/);
      expect(sql).toContain("lowerUTF8(concat(description,' ',tenant_name,' ',arrayStringConcat(target_names,' ')))");
    }
  });

  it('fails closed on a free-text form it does not recognise', () => {
    expect(() => maskActorNameInFilter('search_text = {q0:String}')).toThrow(/cannot be masked/);
  });
});

describe('facets under the actor_email mask', () => {
  const key = Buffer.alloc(32, 7);
  const scope = { tenantId: 'acme', mask: ['actor_email' as const] };
  const range = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' };
  const client = (results: unknown[][]) => {
    const query = vi.fn(async () => ({ json: async () => results.shift() ?? [] }));
    return { ch: { query } as unknown as ClickHouseClient, query };
  };

  it('shows a name that is the address as the pseudonym its events carry, at both levels, and never the address', async () => {
    const marker = `${ACTOR_NAME_MARKER}alice@example.com`;
    const { ch, query } = client([
      [
        { value: 'usr_1', label: marker, count: 3, total: 4 },
        { value: 'usr_2', label: 'Bob', count: 1, total: 4 },
      ],
      [
        { value: 'usr_1', grp: marker, label: marker, count: 3, total: 3 },
        { value: 'usr_2', grp: 'Bob', label: 'Bob', count: 1, total: 1 },
      ],
    ]);
    const result = await facets(ch, 'proj_1', { ...range, field: 'actor', by: 'actor.name', limit: 10 }, scope, undefined, key);
    const pseudonym = maskedEmail('proj_1', 'alice@example.com', key);
    expect(result.values.map((v) => v.label)).toEqual([pseudonym, 'Bob']);
    expect(result.values[0]?.groups?.map((g) => [g.value, g.label])).toEqual([[pseudonym, pseudonym]]);
    expect(JSON.stringify(result)).not.toMatch(/@|logbird-masked-email/);
    // The SQL asked for the masked expression, and the second level filtered on the values as SQL returned them.
    const [first, second] = query.mock.calls.map((call) => (call as unknown as [{ query: string; query_params: Record<string, unknown> }])[0]);
    expect(first?.query).toContain('concat({actorMaskMarker:String},lowerUTF8(actor_email))');
    expect(first?.query_params.actorMaskMarker).toBe(ACTOR_NAME_MARKER);
    expect(second?.query_params.facetValues).toEqual(['usr_1', 'usr_2']);
  });

  it('maps an actor.name value too', async () => {
    const { ch } = client([[{ value: `${ACTOR_NAME_MARKER}carol@example.com`, label: `${ACTOR_NAME_MARKER}carol@example.com`, count: 2, total: 2 }]]);
    const result = await facets(ch, 'proj_1', { ...range, field: 'actor.name', limit: 10 }, scope, undefined, key);
    expect(result.values).toEqual([
      { value: maskedEmail('proj_1', 'carol@example.com', key), label: maskedEmail('proj_1', 'carol@example.com', key), count: 2 },
    ]);
  });

  it('refuses to run without the field mask key', async () => {
    const { ch, query } = client([]);
    await expect(facets(ch, 'proj_1', { ...range, field: 'actor', limit: 10 }, scope)).rejects.toThrow(/requires a field mask key/);
    expect(query).not.toHaveBeenCalled();
  });

  it('leaves unmasked readers exactly as before', async () => {
    const { ch, query } = client([[{ value: 'usr_1', label: 'alice@example.com', count: 1, total: 1 }]]);
    const result = await facets(ch, 'proj_1', { ...range, field: 'actor', limit: 10 });
    expect(result.values[0]?.label).toBe('alice@example.com');
    expect((query.mock.calls[0] as unknown as [{ query: string }])[0].query).not.toContain('actorMaskMarker');
  });
});
