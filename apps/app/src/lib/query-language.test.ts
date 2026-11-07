import { describe, expect, it } from 'vitest';
import {
  andQuery,
  canonicalField,
  excludeTerm,
  formatTerm,
  hasTopLevelOr,
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
      '(outcome:failure OR outcome:denied) -env:staging actor.name:"Omar N" "free text" attr.metadata.plan:pro',
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

  it('lexes the half-typed states the suggestion panel works on', () => {
    // `field:` with nothing after it is still a field token, with an empty value starting after the colon.
    expect(tokenize('tenant:')[0]).toMatchObject({ kind: 'field', field: 'tenant', value: '', valueKind: 'plain', valueStart: 7 });
    expect(tokenize('-tenant:')[0]).toMatchObject({ kind: 'field', field: 'tenant', negated: true, valueStart: 8 });
    // A bare comparison operator: the value is empty, the operator is known.
    expect(tokenize('attempt:>')[0]).toMatchObject({ valueKind: 'compare', op: '>', value: '' });
    // An unclosed group / quote runs to the end of the input.
    expect(tokenize('outcome:(failure OR ')[0]).toMatchObject({ valueKind: 'group', end: 20 });
    expect(tokenize('actor.name:"Ra')[0]).toMatchObject({ valueKind: 'quoted', value: 'Ra' });
    // A lone `-` is plain text, not a negation of nothing.
    expect(tokenize('a -')[2]).toMatchObject({ kind: 'text', raw: '-', negated: false });
  });

  it('keeps offsets exact in the middle of a longer query', () => {
    const q = 'outcome:failure tenant:biz_7 attempt:>2';
    const fields = tokenize(q).filter((t) => t.kind === 'field');
    expect(fields.map((t) => [t.field, t.start, t.end, t.valueStart])).toEqual([
      ['outcome', 0, 15, 8],
      ['tenant', 16, 28, 23],
      ['attempt', 29, 39, 37],
    ]);
    for (const t of fields) expect(q.slice(t.start, t.end)).toBe(t.raw);
  });

  it('lexes Lucene / KQL spellings the linter rewrites', () => {
    // `_exists_:tenant` is an ordinary field token (the linter turns it into `tenant:*`).
    expect(tokenize('_exists_:tenant')[0]).toMatchObject({ kind: 'field', field: '_exists_', value: 'tenant' });
    // KQL `tenant = x` is three words, so the linter can see the `=` between a field name and a value.
    expect(
      tokenize('tenant = x')
        .filter((t) => t.kind !== 'space')
        .map((t) => [t.kind, t.raw]),
    ).toEqual([
      ['text', 'tenant'],
      ['text', '='],
      ['text', 'x'],
    ]);
    // Lower-case boolean words stay text (the server only knows upper-case operators).
    expect(tokenize('a and b').filter((t) => t.kind === 'operator')).toEqual([]);
  });
});

describe('highlightQuery', () => {
  it('covers the input exactly', () => {
    const q = 'action:booking.* attempt:>2 -tenant:* (a OR b) "x y" actor.name:"Omar N"';
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
    expect(queryCompletionAt('act', 3)).toEqual({ kind: 'key', prefix: 'act', from: 0, to: 3, afterTerm: false });
    expect(queryCompletionAt('x -ten', 6)).toEqual({ kind: 'key', prefix: 'ten', from: 3, to: 6, afterTerm: false });
    expect(queryCompletionAt('x -', 3)).toEqual({ kind: 'key', prefix: '', from: 3, to: 3, afterTerm: false });
    expect(queryCompletionAt('', 0)).toEqual({ kind: 'key', prefix: '', from: 0, to: 0, afterTerm: false });
    expect(queryCompletionAt('(', 1)).toEqual({ kind: 'key', prefix: '', from: 1, to: 1, afterTerm: false });
  });

  it('knows when a complete term precedes the caret (boolean operators make sense)', () => {
    expect(queryCompletionAt('x ', 2)).toEqual({ kind: 'key', prefix: '', from: 2, to: 2, afterTerm: true });
    expect(queryCompletionAt('outcome:failure ', 16)).toMatchObject({ kind: 'key', afterTerm: true });
    expect(queryCompletionAt('outcome:failure O', 17)).toMatchObject({ kind: 'key', prefix: 'O', from: 16, afterTerm: true });
    expect(queryCompletionAt('"a phrase" ', 11)).toMatchObject({ kind: 'key', afterTerm: true });
    expect(queryCompletionAt('(a OR b) ', 9)).toMatchObject({ kind: 'key', afterTerm: true });
    // After an operator or an opening parenthesis a term starts.
    expect(queryCompletionAt('a OR ', 5)).toMatchObject({ kind: 'key', afterTerm: false });
    expect(queryCompletionAt('a (', 3)).toMatchObject({ kind: 'key', afterTerm: false });
    expect(queryCompletionAt('a NOT ', 6)).toMatchObject({ kind: 'key', afterTerm: false });
  });

  it('completes the key part of an existing term and replaces through its colon only', () => {
    expect(queryCompletionAt('actor:usr_1', 3)).toEqual({ kind: 'key', prefix: 'act', from: 0, to: 6, afterTerm: false });
    // Editing in the middle of a longer query touches only that token.
    expect(queryCompletionAt('outcome:failure tenant:biz_7 attempt:>2', 18)).toEqual({
      kind: 'key',
      prefix: 'te',
      from: 16,
      to: 23,
      afterTerm: true,
    });
    expect(queryCompletionAt('outcome:failure tenant:biz_7 attempt:>2', 25)).toMatchObject({
      kind: 'value',
      field: 'tenant',
      prefix: 'bi',
      from: 23,
      to: 28,
    });
  });

  it('completes values after field:', () => {
    expect(queryCompletionAt('actor.name:ra', 13)).toEqual({
      kind: 'value',
      field: 'actor.name',
      prefix: 'ra',
      from: 11,
      to: 13,
      inGroup: false,
      quoted: false,
    });
    expect(queryCompletionAt('metadata.channel:', 17)).toMatchObject({ kind: 'value', field: 'metadata.channel', prefix: '', quoted: false });
    expect(queryCompletionAt('attempt:>2', 10)).toMatchObject({ kind: 'value', op: '>', prefix: '2', from: 9 });
    // Right after `attempt:` with an operator typed: still the whole value (the operator can be re-picked).
    expect(queryCompletionAt('attempt:>2', 8)).toMatchObject({ kind: 'value', prefix: '', from: 8, to: 10 });
  });

  it('handles quoted values (unquoted prefix, replaces through the closing quote)', () => {
    expect(queryCompletionAt('actor.name:"Omar N', 18)).toMatchObject({ kind: 'value', prefix: 'Omar N', from: 11, to: 18, quoted: true });
    expect(queryCompletionAt('tenant.name:"Azure Hotels" x', 16)).toMatchObject({ kind: 'value', prefix: 'Azu', from: 12, to: 26, quoted: true });
  });

  it('completes members of a value group and knows when OR comes next', () => {
    expect(queryCompletionAt('action:(booking.created OR boo', 30)).toEqual({
      kind: 'value',
      field: 'action',
      prefix: 'boo',
      from: 27,
      to: 30,
      inGroup: true,
      quoted: false,
      afterMember: false,
    });
    expect(queryCompletionAt('outcome:(failure ', 17)).toMatchObject({ kind: 'value', inGroup: true, prefix: '', afterMember: true });
    expect(queryCompletionAt('outcome:()', 9)).toMatchObject({ kind: 'value', inGroup: true, prefix: '', afterMember: false });
    expect(queryCompletionAt('action:(a OR b)', 11)).toEqual({ kind: 'none' });
  });

  it('explains regexes, ranges and phrases instead of completing inside them', () => {
    expect(queryCompletionAt('action:/boo', 11)).toEqual({ kind: 'regex', field: 'action' });
    expect(queryCompletionAt('attempt:[1 TO', 13)).toEqual({ kind: 'range', field: 'attempt' });
    expect(queryCompletionAt('"free te', 8)).toEqual({ kind: 'phrase' });
  });

  it('treats the caret, not the end of the text, as the completion point', () => {
    const q = 'outcome:failure  attempt:>2';
    // An empty gap between two terms: a new term starts here and the next term is untouched.
    expect(queryCompletionAt(q, 16)).toEqual({ kind: 'key', prefix: '', from: 16, to: 16, afterTerm: true });
    // Inside the first value: only that value is replaced.
    expect(queryCompletionAt(q, 10)).toMatchObject({ kind: 'value', field: 'outcome', prefix: 'fa', from: 8, to: 15 });
    // At the very start of the query, before an existing term.
    expect(queryCompletionAt(q, 0)).toMatchObject({ kind: 'key', prefix: '', from: 0, afterTerm: false });
  });

  it('starts a term inside parentheses and after negation', () => {
    expect(queryCompletionAt('(outcome:failure OR ', 20)).toMatchObject({ kind: 'key', prefix: '', afterTerm: false });
    expect(queryCompletionAt('-(', 2)).toMatchObject({ kind: 'key', prefix: '', from: 2, afterTerm: false });
    expect(queryCompletionAt('-tenant:', 8)).toMatchObject({ kind: 'value', field: 'tenant', prefix: '', from: 8 });
  });

  it('turns Lucene _exists_:field into a field picker for the whole term', () => {
    expect(queryCompletionAt('_exists_:ten', 12)).toEqual({ kind: 'exists', prefix: 'ten', from: 0, to: 12 });
    expect(queryCompletionAt('x -_exists_:imp', 15)).toEqual({ kind: 'exists', prefix: 'imp', from: 3, to: 15 });
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
    // The server lexer splits on : [ ] { } < > too (metadata.jobName:crm:sync:bookings would not mean one value).
    expect(formatTerm('metadata.jobName', 'crm:sync:bookings')).toBe('metadata.jobName:"crm:sync:bookings"');
    expect(formatTerm('attr.range', 'a[1]')).toBe('attr.range:"a[1]"');
    expect(formatTerm('action', 'booking.created')).toBe('action:booking.created');
  });

  it('stacks exclusions and toggles them off', () => {
    const q = excludeTerm(excludeTerm('', 'action', 'a'), 'action', 'b');
    expect(q).toBe('-action:a -action:b');
    expect(toggleTerm(q, 'action', 'a', 'exclude')).toBe('-action:b');
  });
});

describe('andQuery (OR precedence)', () => {
  it('detects only an OR outside every group', () => {
    expect(hasTopLevelOr('outcome:failure OR outcome:denied')).toBe(true);
    expect(hasTopLevelOr('(outcome:failure OR outcome:denied) action:x')).toBe(false);
    expect(hasTopLevelOr('actor:(a OR b)')).toBe(false);
    expect(hasTopLevelOr('-(a OR b) c')).toBe(false);
    expect(hasTopLevelOr('ORDER:x')).toBe(false);
  });

  it('parenthesises a side with a top-level OR so the other side constrains all of it', () => {
    // Explorer's effectiveQ on the agent page: the agent must constrain the whole user query.
    expect(andQuery('impersonator:support_1', 'outcome:failure OR outcome:denied')).toBe(
      'impersonator:support_1 (outcome:failure OR outcome:denied)',
    );
    expect(andQuery('outcome:failure OR outcome:denied', 'impersonator:*')).toBe('(outcome:failure OR outcome:denied) impersonator:*');
    expect(andQuery('a OR b', 'c OR d')).toBe('(a OR b) (c OR d)');
    expect(andQuery('(a OR b)', 'c')).toBe('(a OR b) c');
    expect(andQuery('', 'a OR b')).toBe('a OR b');
    expect(andQuery('actor:x', '')).toBe('actor:x');
  });

  it('includes and excludes facet values across an OR', () => {
    expect(includeTerm('action:a OR action:b', 'outcome', 'failure')).toBe('(action:a OR action:b) outcome:failure');
    expect(excludeTerm('action:a OR action:b', 'outcome', 'failure')).toBe('(action:a OR action:b) -outcome:failure');
  });
});

describe('removeTerm with a unary NOT (round 5)', () => {
  it('removes the NOT with its operand and keeps every other polarity', () => {
    expect(removeTerm('NOT actor:x action:y', 'actor')).toBe('action:y');
    expect(removeTerm('action:y NOT actor:x -tenant:t', 'actor')).toBe('action:y -tenant:t');
    expect(removeTerm('NOT (actor:a OR actor:b) action:y', 'actor')).toBe('action:y');
    expect(removeTerm('NOT actor:x action:y', 'action')).toBe('NOT actor:x');
  });
});
