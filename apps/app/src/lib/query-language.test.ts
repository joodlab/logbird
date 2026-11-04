import { describe, expect, it } from 'vitest';
import { excludeTerm, fieldSpec, includeTerm, removeTerm, toggleTerm, tokenize } from './query-language';

describe('tokenize', () => {
  it('is lossless', () => {
    const q = '(outcome:failure OR outcome:denied) -env:staging actor.name:"Raed B" "free text" attr.metadata.plan:pro';
    expect(
      tokenize(q)
        .map((t) => t.raw)
        .join(''),
    ).toBe(q);
  });

  it('treats only OR as a keyword', () => {
    const kinds = tokenize('a OR b AND c').map((t) => t.kind);
    expect(kinds.filter((k) => k === 'operator')).toHaveLength(1);
  });
});

describe('removeTerm', () => {
  it('removes a whole OR group without leaving dangling syntax', () => {
    expect(removeTerm('tenant.name:"Rawda Suites" (outcome:failure OR outcome:denied)', 'outcome')).toBe('tenant.name:"Rawda Suites"');
    expect(removeTerm('(outcome:failure OR outcome:denied) action:booking.*', 'outcome')).toBe('action:booking.*');
  });

  it('keeps the remaining side of an OR', () => {
    expect(removeTerm('(action:a OR outcome:failure) x', 'outcome')).toBe('(action:a) x');
    expect(removeTerm('a OR outcome:failure', 'outcome')).toBe('a');
  });

  it('treats env and environment as the same field', () => {
    expect(removeTerm('-environment:staging action:x', 'env')).toBe('action:x');
  });
});

describe('include / exclude', () => {
  it('replaces positive terms of the same field', () => {
    expect(includeTerm('outcome:failure action:x', 'outcome', 'denied')).toBe('action:x outcome:denied');
  });

  it('quotes values with spaces', () => {
    expect(includeTerm('', 'tenant.name', 'Azure Hotels')).toBe('tenant.name:"Azure Hotels"');
  });

  it('stacks exclusions and toggles them off', () => {
    const q = excludeTerm(excludeTerm('', 'action', 'a'), 'action', 'b');
    expect(q).toBe('-action:a -action:b');
    expect(toggleTerm(q, 'action', 'a', 'exclude')).toBe('-action:b');
  });
});

describe('fieldSpec', () => {
  it('knows the server query fields', () => {
    for (const key of ['impersonator', 'actor.email', 'parent', 'tenant.name', 'executor.name', 'job']) expect(fieldSpec(key)?.key).toBe(key);
  });

  it('suggests names for *.name fields and attribute values from their own facet', () => {
    expect(fieldSpec('tenant.name')).toMatchObject({ facet: 'tenant', byLabel: true });
    expect(fieldSpec('attr.metadata.plan')?.facet).toBe('attr.metadata.plan');
  });
});
