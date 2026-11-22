import { describe, expect, it } from 'vitest';
import { entityMatchRank, entityQuery, looksLikeId } from './entities';

describe('entity match rank (the order Jump to lists entities in)', () => {
  const tenant = (id: string, name = '') => ({ id, name });
  it('puts an exact id first, then an id prefix, a name prefix, a substring and a fuzzy match', () => {
    expect(entityMatchRank(tenant('biz_27'), 'biz_27')).toBe(0);
    expect(entityMatchRank(tenant('biz_27'), 'BIZ_27 ')).toBe(0);
    expect(entityMatchRank(tenant('biz_270', 'Rimal Crescent'), 'biz_27')).toBe(1);
    expect(entityMatchRank(tenant('biz_7', 'Marsa Lantern Suites'), 'marsa')).toBe(2);
    expect(entityMatchRank(tenant('crm-hourly-biz_7', 'Hourly scheduler - Marsa Lantern Suites'), 'marsa')).toBe(3);
    expect(entityMatchRank(tenant('biz_1', 'Dar Al Wafa'), 'biz_27')).toBe(4);
  });
  it("counts a record's bare id as its id", () => {
    expect(entityMatchRank(tenant('article:article_27_2', 'Umrah Season Packages'), 'article_27_2')).toBe(0);
    expect(entityMatchRank(tenant('article:article_27_2'), 'article:article_27_2')).toBe(0);
    expect(entityMatchRank(tenant('article:article_27_2'), 'article_27')).toBe(1);
  });
});

describe('free text that could be an id', () => {
  it('is one word with no field, operator, quote, group, wildcard or negation', () => {
    for (const id of ['biz_27', 'usr_131', 'article_27_2', 'crm-hourly-biz_7', 'a1']) expect(looksLikeId(id), id).toBe(true);
    for (const text of ['', 'x', 'tenant:biz_27', 'two words', '"biz_27"', 'biz*', '-biz_27', '(biz)', 'AND', 'NOT'])
      expect(looksLikeId(text), text).toBe(false);
  });
  it('builds the id query for each kind', () => {
    expect(entityQuery('tenant', 'biz_27')).toBe('tenant:biz_27');
    expect(entityQuery('target', 'article:article_27_2')).toBe('target:article_27_2 target.type:article');
  });
});
