import { describe, expect, it, vi } from 'vitest';
import {
  ACTOR_NAME_IS_SENSITIVE_SQL,
  actorNameIsSensitive,
  actorNamePseudonymInput,
  facetOrderParams,
  IMPERSONATOR_NAME_IS_SENSITIVE_SQL,
  maskActorNameInFilter,
  maskedEmail,
  maskedFacetText,
} from './actor-name-mask';
import type { ClickHouseClient } from './client';
import { compileMaskedQuery } from './field-mask';
import { facets, searchEvents } from './queries';
import { compileQuery } from './query';

// #333: under the actor_email mask, a reader cannot obtain the actor's address from the actor's own fields (email,
// name), by value, by label, by filter, by order or by free-text match on those fields.
describe('the name rule shared by events and SQL', () => {
  it.each([
    ['alice@example.com', 'alice@example.com', true],
    ['Alice@Example.COM', 'alice@example.com', true],
    [' alice@example.com\t', 'alice@example.com', true],
    ['alice @example.com', 'alice@example.com', true],
    ['alice @ example.com', 'alice@example.com', true],
    // Round 2: a name that carries an address in any form, with or without a matching email.
    ['Ada <ada@example.org>', 'ada@example.org', true],
    // Compatibility forms of '@' (NFKC maps both to '@'): fullwidth and small commercial at.
    ['Rita\uFF20example.invalid', 'rita@example.invalid', true],
    ['rita\uFE6Bexample.invalid', '', true],
    ['contact@acme.example', '', true],
    ['Bob (bob at example)', 'bob@example.com', false],
    ['bob@other.example', 'alice@example.com', true],
    // The stored email cut at its cap ("ada" plus whitespace), a short name that is the full address.
    ['ada@example.org', `ada${' '.repeat(509)}`, true],
    ['Alice', 'alice@example.com', false],
    ['Alice', '', false],
    ['', '', false],
  ])('%j is the address %j: %s', (name, email, expected) => {
    expect(actorNameIsSensitive(name, email)).toBe(expected);
  });

  // A name padded past normalize.ts's 512-unit cap is stored cut: at the cap, a normalised prefix of the email counts.
  it.each([
    [510, false],
    [511, true],
    [512, true],
  ])('a name of %i UTF-16 units (cut at the cap from 511 on) is treated as an address: %s', (units, expected) => {
    const email = 'alice@example.com';
    const name = `alice${' '.repeat(units - 5)}`;
    expect(name.length).toBe(units);
    expect(actorNameIsSensitive(name, email)).toBe(expected);
    // A capped name counts whatever it ends with, with or without an email: the cut can fall inside an address and
    // leave only its local part ("... rita.long" from "... rita.long@example.org").
    expect(actorNameIsSensitive(`bob${' '.repeat(units - 3)}`, email)).toBe(expected);
    const label = `Support ${'-'.repeat(units - 17)}rita.long`;
    expect(label.length).toBe(units);
    expect(actorNameIsSensitive(label, '')).toBe(expected);
    expect(actorNameIsSensitive(label, 'rita.long@example.org')).toBe(expected);
  });
});

describe('the pseudonym a sensitive name shows', () => {
  it.each([
    ['ada@example.org', 'ada@example.org', 'ada@example.org'],
    ['Ada <ada@example.org>', 'ada@example.org', 'ada@example.org'],
    ['contact@acme.example', '', 'contact@acme.example'],
    // Whenever there is an email, the name hashes the email: whether the name holds that address or another one never
    // shows as equal or different pseudonyms.
    ['bob@other.example', 'alice@example.com', 'alice@example.com'],
    ['Support <old@example.org>', 'new@example.org', 'new@example.org'],
    ['ada@example.org', `ada${' '.repeat(509)}`, `ada${' '.repeat(509)}`],
    // A capped name that normalises to nothing (zero-width spaces) still gets a pseudonym, of the name as stored.
    ['\u200B'.repeat(511), '', '\u200B'.repeat(511)],
    // A whitespace-only stored email is still the email (the attribute's own pseudonym hashes it too).
    ['ada@example.org', ' ', ' '],
  ])('%j with email %j hashes %j', (name, email, input) => {
    expect(actorNamePseudonymInput(name, email)).toBe(input);
  });

  it('never shows a flagged facet text under a flag it does not know', () => {
    const key = Buffer.alloc(32, 3);
    expect(maskedFacetText('p', 0, 'Bob', key)).toBe('Bob');
    expect(maskedFacetText('p', 1, 'a@b.example', key)).toBe(maskedEmail('p', 'a@b.example', key));
    expect(maskedFacetText('p', '2', 'a@b.example', key)).toBe(maskedEmail('p', 'a@b.example', key, 'impersonator'));
    for (const flag of [3, -1, '', ' ', '01', '1.0', 'x'])
      expect(() => maskedFacetText('p', flag, 'a@b.example', key), JSON.stringify(flag)).toThrow(/Unknown masked facet flag/);
  });
});

describe('the shared masked-filter compilation (webhook discovery and recheck compile here)', () => {
  it('rewrites actor.name and free text for the actor_email mask, with its parameters, and still refuses actor.email', () => {
    for (const q of ['actor.name:"ada@example.org"', 'ada@example.org']) {
      const compiled = compileMaskedQuery(q, ['actor_email']);
      expect(compiled.sql, q).toContain("match(lowerUTF8(replaceRegexpAll(actor_name,{actorMaskSpaces:String},'')),{actorMaskAt:String})");
      expect(compiled.params).toMatchObject({
        actorMaskSpaces: expect.any(String),
        actorMaskAstral: expect.any(String),
        actorMaskAt: expect.any(String),
      });
    }
    expect(() => compileMaskedQuery('actor.email:"ada@example.org"', ['actor_email'])).toThrow(/masked/);
    // The impersonator's email attribute, the path below it, in every spelling and form, is refused under actor_email.
    for (const q of [
      'impersonator.email:"rita@example.invalid"',
      'attr.impersonator.email:rita*',
      'attributes.impersonator.email:/.*@.*/',
      '_exists_:impersonator.email',
      'impersonator.email:*',
      'NOT impersonator.email:x',
      'impersonator.email:(a OR b)',
      'impersonator.email.work:x',
      'action:x OR impersonator.email:>2',
    ])
      expect(() => compileMaskedQuery(q, ['actor_email']), q).toThrow(/masked/);
    // A sibling path is not the email; other masks do not hide it.
    expect(() => compileMaskedQuery('impersonator.emailVerified:true', ['actor_email'])).not.toThrow();
    expect(() => compileMaskedQuery('impersonator.email:x', ['ip'])).not.toThrow();
    // Other masks and no mask compile as before.
    expect(compileMaskedQuery('actor.name:"x"', ['ip']).sql).not.toContain('actorMaskSpaces');
    expect(compileMaskedQuery('actor.name:"x"', undefined).sql).not.toContain('actorMaskSpaces');
  });
});

describe('the filter rewrite', () => {
  const DEFINED = `(${ACTOR_NAME_IS_SENSITIVE_SQL} AS __lb_name_carries_address)`;
  it('reads an empty name wherever the name is the address, so an actor.name probe never matches those rows', () => {
    for (const q of ['actor.name:"carol@example.com"', 'actor.name:carol*', 'actor.name:*', 'NOT actor.name:"x"', 'actor.name:a OR actor.name:b']) {
      const sql = maskActorNameInFilter(compileQuery(q).sql);
      // The sensitivity test is written once, as an alias; every probe compares against the guarded name.
      expect(sql.split(DEFINED).length, q).toBe(2);
      const rest = sql.replace(DEFINED, 'S');
      expect(rest.match(/\bactor_name\b/g)?.length, q).toBe(rest.match(/,'',actor_name\)/g)?.length);
      expect(rest, q).toMatch(/^[\s\S]*if\((S|__lb_name_carries_address),'',actor_name\)/);
    }
  });

  it('matches free text on a sanitised haystack only, never the stored search_text directly', () => {
    for (const q of ['carol@example.com', 'carol', '"carol example"', 'carol bob actor.name:x']) {
      const sql = maskActorNameInFilter(compileQuery(q).sql);
      expect(sql, q).not.toMatch(/(hasToken|position)\(search_text/);
      expect(sql.match(/\bsearch_text\b/g)?.length, q).toBe(1);
      // Wherever the sensitivity alias happens to be defined, the haystack is the guarded text.
      expect(sql.replace(DEFINED, '__lb_name_carries_address'), q).toContain(
        "if(__lb_name_carries_address,lowerUTF8(concat(description,' ','',' ',tenant_name,' ',arrayStringConcat(target_names,' '))),search_text) AS __lb_masked_haystack)",
      );
      expect(sql.split(DEFINED).length, q).toBe(2);
    }
  });

  it("reads an empty impersonator name wherever it carries the impersonator's address, defining that test once", () => {
    const IMP = `(${IMPERSONATOR_NAME_IS_SENSITIVE_SQL} AS __lb_impersonator_name_carries_address)`;
    const sql = maskActorNameInFilter("impersonator_name = {q0:String} OR startsWith(impersonator_name, {q1:String}) OR actor_name = ''");
    expect(sql.split(IMP).length).toBe(2);
    expect(sql.split(DEFINED).length).toBe(2);
    const rest = sql.replace(IMP, 'S').replace(DEFINED, 'A');
    expect(rest.match(/\bimpersonator_name\b/g)?.length).toBe(rest.match(/,'',impersonator_name\)/g)?.length);
    expect(IMPERSONATOR_NAME_IS_SENSITIVE_SQL).toContain("attributes['impersonator.email']");
    // A filter that never reads the impersonator's name gets no impersonator test.
    expect(maskActorNameInFilter(compileQuery('actor.name:x').sql)).not.toContain('impersonator');
  });

  it('fails closed on a free-text form it does not recognise', () => {
    expect(() => maskActorNameInFilter('search_text = {q0:String}')).toThrow(/cannot be masked/);
  });

  it('keeps a 64-term masked search far below the scoped key 64 KiB SQL limit', async () => {
    const terms = Array.from({ length: 64 }, (_, i) => (i % 2 ? `actor.name:name${i}*` : `term${i}`));
    const sent: string[] = [];
    const query = vi.fn(async ({ query: sql }: { query: string }) => {
      sent.push(sql);
      return { json: async () => [] };
    });
    await searchEvents(
      { query } as unknown as ClickHouseClient,
      'proj_1',
      { from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z', q: terms.join(' '), limit: 50, order: 'desc' },
      undefined,
      { tenantId: 'acme', mask: ['actor_email'] },
    );
    expect(sent.length).toBeGreaterThan(0);
    for (const sql of sent) expect(Buffer.byteLength(sql)).toBeLessThan(32_768);
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
  type Call = { query: string; query_params: Record<string, unknown> };
  const calls = (query: ReturnType<typeof vi.fn>) => query.mock.calls.map((call) => (call as unknown as [Call])[0]);

  it('shows a flagged name as the pseudonym its events carry, at both levels, and never the address', async () => {
    const { ch, query } = client([
      [
        { value: 'usr_1', masked: 0, labf: 1, labt: 'alice@example.com', count: 3, total: 4 },
        { value: 'usr_2', masked: 0, labf: 0, labt: 'Bob', count: 1, total: 4 },
      ],
      [
        { value: 'usr_1', masked: 0, grp: 'alice@example.com', gmasked: 1, labf: 1, labt: 'alice@example.com', count: 3, total: 3 },
        { value: 'usr_2', masked: 0, grp: 'Bob', gmasked: 0, labf: 0, labt: 'Bob', count: 1, total: 1 },
      ],
    ]);
    const result = await facets(ch, 'proj_1', { ...range, field: 'actor', by: 'actor.name', limit: 10 }, scope, undefined, key);
    const pseudonym = maskedEmail('proj_1', 'alice@example.com', key);
    expect(result.values.map((v) => v.label)).toEqual([pseudonym, 'Bob']);
    expect(result.values[0]?.groups?.map((g) => [g.value, g.label])).toEqual([[pseudonym, pseudonym]]);
    expect(JSON.stringify(result)).not.toMatch(/@/);
    const [first, second] = calls(query);
    // The flag is its own column, the groups are keyed by (flag, text), and the second level filters on those keys.
    // The label leaves SQL as scalar columns, never a tuple (whose JSON shape depends on server settings).
    expect(first?.query).toMatch(/ masked,tupleElement\(argMaxIf\(tuple\([\s\S]*\) AS lab,1\) labf,tupleElement\(lab,2\) labt,/);
    expect(second?.query).toContain('tupleElement(lab,2) labt');
    expect(first?.query).toContain('GROUP BY value,masked');
    expect(second?.query_params.facetKeys).toEqual(['0|usr_1', '0|usr_2']);
  });

  it("labels an impersonator by the name rule judged against the impersonator's email, at both levels", async () => {
    const { ch, query } = client([
      [{ value: 'sup_1', masked: 0, labf: 2, labt: 'rita@example.invalid', count: 2, total: 2 }],
      [{ value: 'sup_1', masked: 0, grp: 'sup_1', gmasked: 0, labf: 2, labt: 'rita@example.invalid', count: 2, total: 2 }],
    ]);
    const result = await facets(ch, 'proj_1', { ...range, field: 'impersonator', by: 'impersonator', limit: 10 }, scope, undefined, key);
    // Flag 2: the impersonator's role-keyed pseudonym, never the actor's.
    const pseudonym = maskedEmail('proj_1', 'rita@example.invalid', key, 'impersonator');
    expect(pseudonym).not.toBe(maskedEmail('proj_1', 'rita@example.invalid', key));
    expect(result.values.map((v) => [v.value, v.label])).toEqual([['sup_1', pseudonym]]);
    expect(result.values[0]?.groups?.map((g) => [g.value, g.label])).toEqual([['sup_1', pseudonym]]);
    const [first, second] = calls(query);
    for (const sql of [first?.query, second?.query]) {
      expect(sql).toContain(IMPERSONATOR_NAME_IS_SENSITIVE_SQL);
      expect(sql).not.toMatch(/argMaxIf\(tuple\(0,impersonator_name\)/);
    }
  });

  it('never interprets text by its content: a producer string that looks masked stays as it is', async () => {
    // No '@': the SQL flag marks any name containing one, so this is text the flag really leaves unflagged.
    const forged = '\u0000logbird-masked-email:alice';
    const { ch } = client([[{ value: forged, masked: 0, labf: 0, labt: forged, count: 1, total: 1 }]]);
    const result = await facets(ch, 'proj_1', { ...range, field: 'actor.name', limit: 10 }, scope, undefined, key);
    expect(result.values).toEqual([{ value: forged, label: forged, count: 1 }]);
  });

  it('breaks ties with a keyed hash, the same on every request, so a limit cannot be related to an address', async () => {
    const { ch, query } = client([[{ value: 'carol@example.com', masked: 1, labf: 1, labt: 'carol@example.com', count: 2, total: 2 }]]);
    await facets(ch, 'proj_1', { ...range, field: 'actor.name', limit: 1 }, scope, undefined, key);
    const [first] = calls(query);
    expect(first?.query).toMatch(
      /ORDER BY count DESC,sipHash64Keyed\(\(\{orderKey0:UInt64\},\{orderKey1:UInt64\}\),concat\(toString\(masked\),'\|',value\)\) LIMIT/,
    );
    expect(first?.query_params).toMatchObject(facetOrderParams(key, 'proj_1'));
    // Per project and key, deterministic; different for another project.
    expect(facetOrderParams(key, 'proj_1')).toEqual(facetOrderParams(key, 'proj_1'));
    expect(facetOrderParams(key, 'proj_2')).not.toEqual(facetOrderParams(key, 'proj_1'));
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
    expect(calls(query)[0]?.query).toContain('GROUP BY value ORDER BY count DESC,value LIMIT');
  });
});
