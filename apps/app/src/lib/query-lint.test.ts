import { describe, expect, it } from 'vitest';
import { coreField } from './query-catalog';
import { applyFixes, autoFixes, lintQuery } from './query-lint';

const isField = (name: string) => Boolean(coreField(name)) || name === 'metadata.channel';
const fix = (q: string) => applyFixes(q, autoFixes(lintQuery(q, isField)));

describe('lintQuery: Lucene / KQL / Datadog spellings', () => {
  it('rewrites Lucene _exists_ to field:*', () => {
    expect(fix('_exists_:impersonator')).toBe('impersonator:*');
    expect(fix('outcome:failure -_exists_:tenant')).toBe('outcome:failure -tenant:*');
    expect(lintQuery('_exists_:tenant', isField)[0]).toMatchObject({ start: 0, end: 15, replacement: 'tenant:*' });
  });

  it('rewrites KQL / SQL-ish comparisons on known fields', () => {
    expect(fix('tenant = biz_7')).toBe('tenant:biz_7');
    expect(fix('tenant == biz_7 outcome:failure')).toBe('tenant:biz_7 outcome:failure');
    expect(fix('outcome != success')).toBe('-outcome:success');
    expect(fix('attempt > 2')).toBe('attempt:>2');
    expect(fix('attempt >= 2')).toBe('attempt:>=2');
    expect(fix('tenant.name = "Azure Hotels"')).toBe('tenant.name:"Azure Hotels"');
    expect(fix('attempt>2 tenant=biz_7')).toBe('attempt:>2 tenant:biz_7');
    expect(fix('metadata.channel = whatsapp')).toBe('metadata.channel:whatsapp');
  });

  it('leaves free text alone (unknown words are not fields)', () => {
    expect(lintQuery('price = cheap', isField)).toEqual([]);
    expect(lintQuery('a=b', isField)).toEqual([]);
  });

  it('marks an unfinished comparison as incomplete (shown, never auto-applied)', () => {
    const [f] = lintQuery('outcome:failure tenant =', isField);
    expect(f).toMatchObject({ start: 16, end: 24, replacement: 'tenant:', incomplete: true });
    expect(fix('outcome:failure tenant =')).toBe('outcome:failure tenant =');
    expect(lintQuery('outcome !=', isField)[0]).toMatchObject({ replacement: '-outcome:', incomplete: true });
  });

  it('joins Kibana-style spacing around the colon', () => {
    expect(fix('tenant: biz_7')).toBe('tenant:biz_7');
    expect(fix('tenant :biz_7')).toBe('tenant:biz_7');
    // `tenant:` followed by another term is just an unfinished value, not spacing.
    expect(lintQuery('tenant: outcome:failure', isField)).toEqual([]);
  });

  it('converts ! negation and && / || operators', () => {
    expect(fix('!env:staging')).toBe('-env:staging');
    expect(fix('outcome:failure && attempt:>2')).toBe('outcome:failure AND attempt:>2');
    expect(fix('outcome:failure || outcome:denied')).toBe('outcome:failure OR outcome:denied');
  });

  it('only hints at lower-case boolean words (they may be searched text)', () => {
    const fixes = lintQuery('outcome:failure or outcome:denied', isField);
    expect(fixes).toEqual([expect.objectContaining({ replacement: 'OR', soft: true })]);
    expect(fix('outcome:failure or outcome:denied')).toBe('outcome:failure or outcome:denied');
    expect(lintQuery('rock and', isField)).toEqual([]);
  });

  it('applies several fixes with stable offsets', () => {
    expect(fix('_exists_:tenant && attempt >= 3 && outcome != success')).toBe('tenant:* AND attempt:>=3 AND -outcome:success');
  });
});
