import { formatRecordTerm } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import {
  countsMentions,
  entityBaseQuery,
  entityMatchRank,
  entityQuery,
  exactPerKind,
  historyBounds,
  idFromFreeText,
  lookupType,
  resolveJump,
  settledIdMatches,
} from './entities';

describe('entity match rank (the order Jump to lists entities in)', () => {
  const tenant = (id: string, name = '') => ({ kind: 'tenant' as const, id, name, type: '' });
  const record = (type: string, id: string, name = '') => ({ kind: 'target' as const, id: `${type}:${id}`, name, type });
  it('puts an exact id first, then an id prefix, a name prefix, a substring and a fuzzy match', () => {
    expect(entityMatchRank(tenant('biz_27'), 'biz_27')).toBe(0);
    expect(entityMatchRank(tenant('biz_27'), ' biz_27 ')).toBe(0);
    // The id in another case is exact too, after the literal one.
    expect(entityMatchRank(tenant('BIZ_27'), 'biz_27')).toBe(1);
    expect(entityMatchRank(tenant('biz_270', 'Rimal Crescent'), 'biz_27')).toBe(2);
    expect(entityMatchRank(tenant('biz_7', 'Marsa Lantern Suites'), 'marsa')).toBe(3);
    expect(entityMatchRank(tenant('crm-hourly-biz_7', 'Hourly scheduler - Marsa Lantern Suites'), 'marsa')).toBe(4);
    expect(entityMatchRank(tenant('biz_1', 'Dar Al Wafa'), 'biz_27')).toBe(5);
  });
  it("counts a record's bare id as its id, after its own type only", () => {
    expect(entityMatchRank(record('article', 'article_27_2', 'Umrah Season Packages'), 'article_27_2')).toBe(0);
    expect(entityMatchRank(record('article', 'article_27_2'), 'article:article_27_2')).toBe(0);
    expect(entityMatchRank(record('article', 'article_27_2'), 'article_27')).toBe(2);
    // A type with a colon in it: the bare id is what follows the whole type.
    expect(entityMatchRank(record('catalog:article', 'article_27_2'), 'article_27_2')).toBe(0);
    expect(entityMatchRank(record('post', 'article_27_20'), 'article_27_2')).toBe(2);
    // A record stored without a type (`:7`) is found by its bare id.
    expect(entityMatchRank(record('', '7'), '7')).toBe(0);
  });
  it('keeps other ids whole: a tenant `a:biz_27` is not `biz_27`', () => {
    expect(entityMatchRank(tenant('a:biz_27'), 'biz_27')).toBe(4);
    expect(entityMatchRank(tenant('a:biz_27'), 'a:biz_27')).toBe(0);
  });
});

describe('the id that free text could be', () => {
  it('is one bare word with no field, operator, group, wildcard or negation, or one quoted term', () => {
    for (const id of ['biz_27', 'usr_131', 'article_27_2', 'crm-hourly-biz_7', '7']) expect(idFromFreeText(id), id).toBe(id);
    expect(idFromFreeText('"acme:27"')).toBe('acme:27');
    expect(idFromFreeText('"acme west"')).toBe('acme west');
    // An escaped quote inside the quotes is part of the id, as the server reads it.
    expect(idFromFreeText('"acme\\"27"')).toBe('acme"27');
    // Spaces inside the quotes are part of the id, as the server reads it: never trimmed into another id.
    expect(idFromFreeText('" a\\"b "')).toBe(' a"b ');
    expect(idFromFreeText('"   "')).toBe('');
    // A leading slash starts a regex to the server, never an id.
    expect(idFromFreeText('/x/')).toBe('');
    for (const text of ['', 'tenant:biz_27', 'two words', '"a"b"', 'biz*', '-biz_27', '(biz)', 'AND', 'NOT'])
      expect(idFromFreeText(text), text).toBe('');
  });
  it('builds the id query for each kind', () => {
    expect(entityQuery('tenant', 'biz_27')).toBe('tenant:biz_27');
    // A record is one paired term: its type and id at the same position.
    expect(entityQuery('target', 'article:article_27_2', 'article')).toBe('record:"article:article_27_2"');
  });
});

describe('where Jump to goes for pasted text', () => {
  const entities = [
    { kind: 'tenant' as const, id: 'op_customer', name: 'Opal Clinics', type: '' },
    { kind: 'actor' as const, id: 'evt_bot', name: 'Event bot', type: 'service' },
    { kind: 'target' as const, id: 'booking:op_77', name: 'Booking 77', type: 'booking' },
  ];
  it('opens an entity whose id is exactly the text, whatever its prefix', () => {
    expect(resolveJump('op_customer', 'operation', entities)).toEqual({ kind: 'entity', entity: entities[0] });
    expect(resolveJump('evt_bot', 'event', entities)).toEqual({ kind: 'entity', entity: entities[1] });
    expect(resolveJump('op_77', 'operation', entities)).toEqual({ kind: 'entity', entity: entities[2] });
  });
  it('falls back to the id shape, then to a search', () => {
    expect(resolveJump('op_123', 'operation', entities)).toEqual({ kind: 'operation' });
    expect(resolveJump('evt_9', 'event', entities)).toEqual({ kind: 'event' });
    expect(resolveJump('op_123', 'operation', undefined)).toEqual({ kind: 'operation' });
    expect(resolveJump('something', null, entities)).toEqual({ kind: 'search' });
  });
});

describe('exact ids, one per kind', () => {
  it('keeps the literal id per kind, so case variants of one kind never crowd out another kind', () => {
    const e = (kind: 'actor' | 'tenant' | 'executor' | 'target', id: string, type = '') => ({ kind, id, name: '', type });
    const found = [
      e('actor', 'ACME'),
      e('actor', 'Acme'),
      e('actor', 'acme'),
      e('actor', 'aCme'),
      e('tenant', 'acme'),
      e('executor', 'ACME'),
      e('target', 'doc:ACME', 'doc'),
    ];
    expect(exactPerKind(found, 'acme').map((x) => `${x.kind}:${x.id}`)).toEqual(['actor:acme', 'tenant:acme', 'executor:ACME', 'target:doc:ACME']);
  });
});

describe('a record page history starts from the link when it carries the exact pair (#220 item 5)', () => {
  it('uses the linked type at once, falls back to the profile, and never guesses', () => {
    expect(entityBaseQuery('target', 'order:archived:A1', 'order:archived', undefined)).toBe(formatRecordTerm('order:archived', 'A1'));
    // Before the profile arrives and without a linked type: no history yet, rather than a guessed split.
    expect(entityBaseQuery('target', 'order:archived:A1', undefined, undefined)).toBe('');
    expect(entityBaseQuery('target', 'order:archived:A1', undefined, 'order:archived')).toBe(formatRecordTerm('order:archived', 'A1'));
    // A linked type that does not belong to the id is ignored.
    expect(entityBaseQuery('target', 'order:archived:A1', 'invoice', undefined)).toBe('');
    expect(entityBaseQuery('actor', 'qa-user-1', undefined, undefined)).toBe('actor:qa-user-1');
  });

  it('calls the all-time count mentions only where the server reads it from the rollup', () => {
    expect(countsMentions('target', 'page:7')).toBe(true);
    // More colons: the server counts the events themselves.
    expect(countsMentions('target', 'order:archived:A1')).toBe(false);
    expect(countsMentions('actor', 'qa-user-1')).toBe(false);
  });

  it('starts the history window from whichever source answers first and only ever widens it', () => {
    const directory = { firstSeen: '2026-11-22T00:00:00.000Z', lastSeen: '2026-11-23T00:00:00.000Z' };
    const profile = { firstSeen: '2026-11-13T00:00:00.000Z', lastSeen: '2026-11-22T12:00:00.000Z' };
    expect(historyBounds(undefined, undefined)).toBeNull();
    expect(historyBounds(directory, undefined)).toEqual(directory);
    expect(historyBounds(null, profile)).toEqual(profile);
    // A late-arriving older event the profile reports is never left out of the history.
    expect(historyBounds(directory, profile)).toEqual({ firstSeen: profile.firstSeen, lastSeen: directory.lastSeen });
  });

  it('looks a record up by a type that belongs to it', () => {
    expect(lookupType('target', 'page:7', 'page')).toBe('page');
    expect(lookupType('target', 'page:7', undefined)).toBe('page');
    expect(lookupType('target', 'page:7', 'invoice')).toBe('page');
    expect(lookupType('target', 'order:archived:A1', 'order:archived')).toBe('order:archived');
    expect(lookupType('target', 'order:archived:A1', undefined)).toBeUndefined();
    expect(lookupType('actor', 'qa-user-1', undefined)).toBeUndefined();
  });
});

describe('settledIdMatches (#324 A3, A4)', () => {
  const tenant = { kind: 'tenant' as const, id: 'ACME"27', name: 'West Depot' };
  const biz = { kind: 'tenant' as const, id: 'biz_27', name: 'Biz' };
  it('offers nothing while the lookup has not settled, even with a cached hit', () => {
    expect(settledIdMatches('biz_27', false, [biz])).toEqual([]);
    expect(settledIdMatches('biz_27', true, [biz])).toEqual([biz]);
  });
  it('matches a quoted literal as written: a space inside the quotes is part of the id', () => {
    expect(settledIdMatches('ACME"27 ', true, [tenant])).toEqual([]);
    expect(settledIdMatches('ACME"27', true, [tenant])).toEqual([tenant]);
    expect(idFromFreeText('"ACME\\"27 "')).toBe('ACME"27 ');
  });
});

describe('idFromFreeText, as the server parses a bare word (#334)', () => {
  it('takes any single literal word the parser reads, an apostrophe included', () => {
    expect(idFromFreeText("o'brien")).toBe("o'brien");
    expect(idFromFreeText('biz_27')).toBe('biz_27');
    expect(idFromFreeText('  biz_27 ')).toBe('biz_27');
  });
  it('never takes a field, a negation, a wildcard, a regex, several words or an operator', () => {
    for (const t of ['actor:x', '-x', 'foo*', '/x/', 'a b', 'AND', '(x)', '']) expect(idFromFreeText(t)).toBe('');
  });
});

describe('idFromFreeText within the directory search limit (#334)', () => {
  it('never offers a lookup the entity directory would refuse as too long', () => {
    expect(idFromFreeText(`${'x'.repeat(1023)}'`)).toBe(`${'x'.repeat(1023)}'`);
    expect(idFromFreeText(`${'x'.repeat(1024)}'`)).toBe('');
    expect(idFromFreeText(`"${'y'.repeat(1025)}"`)).toBe('');
  });
});
