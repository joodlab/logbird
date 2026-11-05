import { describe, expect, it } from 'vitest';
import {
  canonicalField,
  excludeTerm,
  formatTerm,
  highlightQuery,
  includeTerm,
  markErrorSpan,
  queryCompletionAt,
  removeTerm,
  type Segment,
  toggleTerm,
  tokenize,
} from './query-language';

/** `text:cls` pairs for non-space segments, to assert highlighting compactly. */
function classes(q: string, segments: Segment[] = highlightQuery(q)): string[] {
  return segments.filter((s) => s.cls !== 'plain').map((s) => `${q.slice(s.start, s.end)}:${s.cls}${s.error ? '!' : ''}`);
}

describe('tokenize', () => {
  it('is lossless for v0 and v2 syntax', () => {
    for (const q of [
      '(outcome:failure OR outcome:denied) -env:staging actor.name:"Raed B" "free text" attr.metadata.plan:pro',
      'attempt:>=2 duration_ms:[100 TO 500} action:/booking\\.(created|cancelled)/ -outcome:(failure OR denied)',
      'occurredAt:[2026-11-01 TO 2026-11-03T12:00:00Z] NOT a AND b -(x OR y) trace:abc:def',
      'action:(booking.* OR "a b"', // unclosed group
      'actor.name:"Ra', // unclosed quote
    ]) {
      expect(
        tokenize(q)
          .map((t) => t.raw)
          .join(''),
      ).toBe(q);
    }
  });

  it('recognises OR, AND and NOT as keywords (upper-case only)', () => {
    const ops = tokenize('a OR b AND c NOT d or e').filter((t) => t.kind === 'operator');
    expect(ops.map((t) => t.raw)).toEqual(['OR', 'AND', 'NOT']);
  });

  it('keeps a whole range, regex and value group in one field token', () => {
    const [range, , regex, , group] = tokenize('attempt:[2 TO *] action:/a b\\/c/ outcome:(failure OR denied)');
    expect(range).toMatchObject({ kind: 'field', field: 'attempt', valueKind: 'range', value: '[2 TO *]' });
    expect(regex).toMatchObject({ field: 'action', valueKind: 'regex', value: '/a b\\/c/' });
    expect(group).toMatchObject({ field: 'outcome', valueKind: 'group', value: '(failure OR denied)' });
  });

  it('separates comparison operators from their value', () => {
    expect(tokenize('attempt:>=2')[0]).toMatchObject({ valueKind: 'compare', op: '>=', value: '2', valueStart: 8 });
  });

  it('treats -( as a negated group', () => {
    expect(tokenize('-(a OR b)')[0]).toMatchObject({ kind: 'paren', raw: '-(', negated: true });
  });
});

describe('highlightQuery', () => {
  it('covers the input exactly', () => {
    const q = 'action:booking.* attempt:>2 -tenant:* (a OR b) "x y" actor.name:"Raed B"';
    const segs = highlightQuery(q);
    expect(segs.map((s) => q.slice(s.start, s.end)).join('')).toBe(q);
    segs.forEach((s, i) => {
      if (i > 0) expect(s.start).toBe(segs[i - 1]?.end);
    });
  });

  it('colours keys, operators, wildcards and negation', () => {
    expect(classes('action:booking.* attempt:>2 -tenant:*')).toEqual([
      'action:key',
      '::punct',
      'booking.:value',
      '*:wildcard',
      'attempt:key',
      '::punct',
      '>:operator',
      '2:number',
      '-:negation',
      'tenant:negation',
      '::punct',
      '*:wildcard',
    ]);
  });

  it('colours ranges, regexes, groups and keywords', () => {
    expect(classes('duration_ms:[100 TO *]')).toEqual(['duration_ms:key', '::punct', '[:punct', '100:number', 'TO:keyword', '*:wildcard', ']:punct']);
    expect(classes('action:/a.b/')).toEqual(['action:key', '::punct', '/:punct', 'a.b:regex', '/:punct']);
    expect(classes('outcome:(failure OR denied) NOT x')).toEqual([
      'outcome:key',
      '::punct',
      '(:punct',
      'failure:value',
      'OR:keyword',
      'denied:value',
      '):punct',
      'NOT:keyword',
      'x:value',
    ]);
    expect(classes('occurredAt:>2026-11-01')).toContain('2026-11-01:number');
  });
});

describe('markErrorSpan', () => {
  it('splits segments at the error edges', () => {
    const q = 'attempt:>abc';
    expect(classes(q, markErrorSpan(highlightQuery(q), 9, 12))).toEqual(['attempt:key', '::punct', '>:operator', 'abc:value!']);
    expect(classes(q, markErrorSpan(highlightQuery(q), 2, 10))).toEqual(['at:key', 'tempt:key!', '::punct!', '>:operator!', 'a:value!', 'bc:value']);
  });

  it('marks nothing for zero-width or missing spans', () => {
    const segs = highlightQuery('a:b');
    expect(markErrorSpan(segs, 1, 1)).toBe(segs);
    expect(markErrorSpan(segs, null, null)).toBe(segs);
  });
});

describe('queryCompletionAt', () => {
  it('completes keys for bare words, keeping a leading -', () => {
    expect(queryCompletionAt('act', 3)).toEqual({ kind: 'key', prefix: 'act', from: 0, to: 3 });
    expect(queryCompletionAt('x -ten', 6)).toEqual({ kind: 'key', prefix: 'ten', from: 3, to: 6 });
    expect(queryCompletionAt('x ', 2)).toEqual({ kind: 'key', prefix: '', from: 2, to: 2 });
    expect(queryCompletionAt('(', 1)).toEqual({ kind: 'key', prefix: '', from: 1, to: 1 });
  });

  it('completes the key part of an existing term', () => {
    expect(queryCompletionAt('actor:usr_1', 3)).toEqual({ kind: 'key', prefix: 'act', from: 0, to: 6 });
  });

  it('completes values after field:', () => {
    expect(queryCompletionAt('actor.name:ra', 13)).toEqual({ kind: 'value', field: 'actor.name', prefix: 'ra', from: 11, to: 13, inGroup: false });
    expect(queryCompletionAt('actor.name:"Raed B', 18)).toMatchObject({ kind: 'value', prefix: 'Raed B', from: 11 });
    expect(queryCompletionAt('metadata.channel:', 17)).toMatchObject({ kind: 'value', field: 'metadata.channel', prefix: '' });
    expect(queryCompletionAt('attempt:>2', 10)).toMatchObject({ kind: 'value', op: '>', prefix: '2', from: 9 });
  });

  it('completes members of a value group', () => {
    expect(queryCompletionAt('action:(booking.created OR boo', 30)).toEqual({
      kind: 'value',
      field: 'action',
      prefix: 'boo',
      from: 27,
      to: 30,
      inGroup: true,
    });
    expect(queryCompletionAt('action:(a OR b)', 11)).toEqual({ kind: 'none' });
  });

  it('does not complete inside regexes, ranges and phrases', () => {
    expect(queryCompletionAt('action:/boo', 11)).toEqual({ kind: 'none' });
    expect(queryCompletionAt('attempt:[1 TO', 13)).toEqual({ kind: 'none' });
    expect(queryCompletionAt('"free te', 8)).toEqual({ kind: 'none' });
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
    expect(removeTerm('a AND outcome:failure', 'outcome')).toBe('a');
  });

  it('treats aliases and attribute spellings as the same field', () => {
    expect(removeTerm('-environment:staging action:x', 'env')).toBe('action:x');
    expect(removeTerm('metadata.plan:pro x', 'attr.metadata.plan')).toBe('x');
    expect(canonicalField('attributes.foo')).toBe('attr.foo');
    expect(canonicalField('timestamp')).toBe('occurredAt');
  });

  it('removes v2 terms of a field', () => {
    expect(removeTerm('outcome:(failure OR denied) attempt:>2', 'outcome')).toBe('attempt:>2');
  });
});

describe('include / exclude', () => {
  it('replaces positive terms of the same field', () => {
    expect(includeTerm('outcome:failure action:x', 'outcome', 'denied')).toBe('action:x outcome:denied');
  });

  it('quotes values that would otherwise parse differently', () => {
    expect(includeTerm('', 'tenant.name', 'Azure Hotels')).toBe('tenant.name:"Azure Hotels"');
    expect(formatTerm('action', 'OR')).toBe('action:"OR"');
    expect(formatTerm('attr.note', '>5')).toBe('attr.note:">5"');
    expect(formatTerm('attr.path', '/a/b')).toBe('attr.path:"/a/b"');
  });

  it('stacks exclusions and toggles them off', () => {
    const q = excludeTerm(excludeTerm('', 'action', 'a'), 'action', 'b');
    expect(q).toBe('-action:a -action:b');
    expect(toggleTerm(q, 'action', 'a', 'exclude')).toBe('-action:b');
  });
});
