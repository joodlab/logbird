import { describe, expect, it } from 'vitest';
import { entityMatchRank, entityQuery, idFromFreeText } from './entities';

describe('entity match rank (the order Jump to lists entities in)', () => {
  const tenant = (id: string, name = '') => ({ kind: 'tenant' as const, id, name, type: '' });
  const record = (type: string, id: string, name = '') => ({ kind: 'target' as const, id: `${type}:${id}`, name, type });
  it('puts an exact id first, then an id prefix, a name prefix, a substring and a fuzzy match', () => {
    expect(entityMatchRank(tenant('biz_27'), 'biz_27')).toBe(0);
    expect(entityMatchRank(tenant('biz_27'), 'BIZ_27 ')).toBe(0);
    expect(entityMatchRank(tenant('biz_270', 'Rimal Crescent'), 'biz_27')).toBe(1);
    expect(entityMatchRank(tenant('biz_7', 'Marsa Lantern Suites'), 'marsa')).toBe(2);
    expect(entityMatchRank(tenant('crm-hourly-biz_7', 'Hourly scheduler - Marsa Lantern Suites'), 'marsa')).toBe(3);
    expect(entityMatchRank(tenant('biz_1', 'Dar Al Wafa'), 'biz_27')).toBe(4);
  });
  it("counts a record's bare id as its id, after its own type only", () => {
    expect(entityMatchRank(record('article', 'article_27_2', 'Umrah Season Packages'), 'article_27_2')).toBe(0);
    expect(entityMatchRank(record('article', 'article_27_2'), 'article:article_27_2')).toBe(0);
    expect(entityMatchRank(record('article', 'article_27_2'), 'article_27')).toBe(1);
    // A type with a colon in it: the bare id is what follows the whole type.
    expect(entityMatchRank(record('catalog:article', 'article_27_2'), 'article_27_2')).toBe(0);
    expect(entityMatchRank(record('post', 'article_27_20'), 'article_27_2')).toBe(1);
  });
  it('keeps other ids whole: a tenant `a:biz_27` is not `biz_27`', () => {
    expect(entityMatchRank(tenant('a:biz_27'), 'biz_27')).toBe(3);
    expect(entityMatchRank(tenant('a:biz_27'), 'a:biz_27')).toBe(0);
  });
});

describe('the id that free text could be', () => {
  it('is one bare word with no field, operator, group, wildcard or negation, or one quoted term', () => {
    for (const id of ['biz_27', 'usr_131', 'article_27_2', 'crm-hourly-biz_7', '7']) expect(idFromFreeText(id), id).toBe(id);
    expect(idFromFreeText('"acme:27"')).toBe('acme:27');
    expect(idFromFreeText('"acme west"')).toBe('acme west');
    for (const text of ['', 'tenant:biz_27', 'two words', '"a"b"', 'biz*', '-biz_27', '(biz)', 'AND', 'NOT'])
      expect(idFromFreeText(text), text).toBe('');
  });
  it('builds the id query for each kind', () => {
    expect(entityQuery('tenant', 'biz_27')).toBe('tenant:biz_27');
    // A record is one paired term: its type and id at the same position.
    expect(entityQuery('target', 'article:article_27_2', 'article')).toBe('record:"article:article_27_2"');
  });
});
