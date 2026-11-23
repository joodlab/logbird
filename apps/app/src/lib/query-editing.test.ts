// Chips, labels and editing keep a query's meaning (#220, items 11-15).
import { compileQuery } from '@logbird/clickhouse';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', () => ({ api: {} }));

import { editorQuery } from '@/components/query-input/query-input';
import { keyItem } from '@/components/query-input/use-completions';
import { activityChip, activityFreeText } from './activity-search';
import { whoFilter } from './impersonation';
import { presenceTerms } from './presence-filter';
import { attributeQueryKey } from './query-catalog';
import { excludeTerm, fieldTerms, formatTerm, highlightQuery, includeTerm, queryCompletionAt, removeTerm, tokenize } from './query-language';
import { lintQuery } from './query-lint';
import { translateQueryToSql } from './query-translate';
import { nameableTerms } from './views';

describe('a negated group negates every term inside it (item 11)', () => {
  it('reports each term with the polarity it has in the whole query', () => {
    expect(fieldTerms('NOT (record:page:7)').map((t) => t.negated)).toEqual([true]);
    expect(fieldTerms('-(actor:a OR tenant:b) outcome:failure').map((t) => [t.field, t.negated])).toEqual([
      ['actor', true],
      ['tenant', true],
      ['outcome', false],
    ]);
    expect(fieldTerms('NOT -(actor:a)').map((t) => t.negated)).toEqual([false]);
    // NOT (a AND b) is NOT a OR NOT b: neither term has a polarity of its own, so neither is reported.
    expect(fieldTerms('NOT (actor:a -tenant:b)')).toEqual([]);
    expect(fieldTerms('NOT (actor:a OR tenant:b)').map((t) => t.negated)).toEqual([true, true]);
  });

  it('never names an excluded record, and reads NOT (impersonator:*) as hiding support activity', () => {
    expect(nameableTerms('NOT (record:page:7)')).toEqual([]);
    expect(nameableTerms('record:page:7')).toEqual([{ field: 'record', value: 'page:7' }]);
    expect(presenceTerms('NOT (impersonator:*)', 'impersonator')).toEqual([expect.objectContaining({ value: null, negated: true })]);
  });

  it('removes a term by the same polarity it reports', () => {
    expect(removeTerm('NOT (record:page:7) outcome:failure', 'record', 'page:7', true)).toBe('outcome:failure');
    expect(removeTerm('NOT (record:page:7) outcome:failure', 'record', 'page:7', false)).toBe('NOT (record:page:7) outcome:failure');
  });
});

describe('attribute keys that are not plain names (item 12)', () => {
  it('quotes the field, and every reader sees the same field and value', () => {
    const term = formatTerm('attr.ticket status', 'open');
    expect(term).toBe('"attr.ticket status":open');
    expect(compileQuery(term).params).toMatchObject({ q0: 'ticket status', q1: 'open' });
    const [token] = tokenize(term);
    expect(token).toMatchObject({ kind: 'field', field: 'attr.ticket status', value: 'open', negated: false });
    expect(translateQueryToSql(term)).toBe("(mapContains(attributes, 'ticket status') AND attributes['ticket status'] = 'open')");
    expect(fieldTerms(term).map((t) => [t.field, t.value])).toEqual([['attr.ticket status', 'open']]);
    expect(formatTerm('attr.plan', 'pro')).toBe('attr.plan:pro');
    expect(formatTerm('attr.a:b', 'x')).toBe('"attr.a:b":x');
  });
});

describe('completion inside a quoted group member (item 13)', () => {
  it('replaces the whole quoted member, not the word under the caret', () => {
    const q = 'record:("page:New York" OR page:7)';
    const caret = q.indexOf('York') + 2;
    const c = queryCompletionAt(q, caret);
    expect(c).toMatchObject({ kind: 'value', inGroup: true, quoted: true, from: q.indexOf('"'), to: q.indexOf('" OR') + 1 });
    const second = queryCompletionAt(q, q.indexOf('page:7') + 3);
    expect(second).toMatchObject({ from: q.indexOf('page:7'), to: q.indexOf('page:7') + 'page:7'.length, afterMember: false });
  });
});

describe('a slash-delimited field name with a literal CR (item 14)', () => {
  it('becomes the same field quoted, never a renamed one', () => {
    const q = '/a\rb/:x';
    const edited = editorQuery(q, 'query');
    expect(edited).not.toContain('\r');
    expect(compileQuery(edited).params).toEqual(compileQuery(q).params);
  });
});

describe('workspace activity chips (item 15)', () => {
  it('never lifts category: out of a quoted description', () => {
    const q = 'description:"category:alpha beta"';
    expect(activityChip(q)).toBeUndefined();
    expect(activityFreeText(q)).toBe(q);
  });
});

describe('a quoted key is kept as written by every reader (item 12)', () => {
  it('highlights the whole key, completes after the real colon and proposes no rewrite of it', () => {
    const q = '"attr.ticket status":open';
    const key = highlightQuery(q).find((s) => s.cls === 'key');
    expect(key && q.slice(key.start, key.end)).toBe('"attr.ticket status"');
    expect(lintQuery(q, () => true)).toEqual([]);
    expect(lintQuery('"attr.ticket status" : open', () => true)).toEqual([
      expect.objectContaining({ replacement: '"attr.ticket status":open', message: 'Remove space around the colon' }),
    ]);
    const colonInside = '"attr.a:b":x';
    expect(queryCompletionAt(colonInside, colonInside.length)).toMatchObject({ kind: 'value', field: 'attr.a:b', from: colonInside.indexOf('x') });
  });
});

describe('#283 round 1: every reader agrees with the server', () => {
  it('never rewrites a field literally named _exists_ into a question about another field', () => {
    expect(lintQuery('"_exists_":_exists_', () => true)).toEqual([]);
    expect(lintQuery('_exists_:_exists_', () => true)).toEqual([]);
    expect(lintQuery('_exists_:tenant', () => true)).toEqual([expect.objectContaining({ replacement: 'tenant:*' })]);
  });

  it('takes no chip from a value the server joins with a colon', () => {
    const q = '"category":"auth":other';
    expect(activityChip(q)).toBeUndefined();
    expect(activityFreeText(q)).toBe(q);
    expect(activityChip('revoked AND "category":auth')).toBe('auth');
  });

  it('reads no support split from a term inside NOT (a AND b)', () => {
    expect(whoFilter('NOT (impersonator:* outcome:failure)')).toBe('all');
    expect(whoFilter('NOT (impersonator:*)')).toBe('self');
    expect(whoFilter('NOT (impersonator:* OR impersonator:qa-agent-1)')).toBe('self');
    // Removing every outcome term still reaches inside such a group; asking for one polarity never does.
    expect(removeTerm('NOT (outcome:failure action:x)', 'outcome', 'failure', true)).toBe('NOT (outcome:failure action:x)');
    expect(removeTerm('NOT (outcome:failure action:x)', 'outcome')).toBe('NOT (action:x)');
  });

  it('completes a whole group member as the server lexes it', () => {
    // Inside a regex member nothing is offered that could replace the pattern (a quote inside it opens nothing either).
    const regex = 'action:(/booking updated/ OR cancel)';
    expect(queryCompletionAt(regex, regex.indexOf('updated') + 2)).toMatchObject({ kind: 'regex' });
    const quoteInRegex = 'action:(/foo "bar/ OR baz)';
    expect(queryCompletionAt(quoteInRegex, quoteInRegex.indexOf('"') + 1)).toMatchObject({ kind: 'regex' });
    expect(queryCompletionAt(quoteInRegex, quoteInRegex.indexOf('baz') + 2)).toMatchObject({ kind: 'value', from: quoteInRegex.indexOf('baz') });
    const joined = 'action:(tag:"two words" OR ok)';
    expect(queryCompletionAt(joined, joined.indexOf('words') + 2)).toMatchObject({ from: joined.indexOf('tag'), to: joined.indexOf(' OR') });
  });

  it('quotes a discovered attribute key that is not a plain name when completing it', () => {
    const spec = { id: 'k', kind: 'attr', badge: 'attr', group: 'Attributes' } as const;
    expect(keyItem('ticket status', spec, { from: 0, to: 0 }).insert).toBe('"ticket status":');
    expect(keyItem('plan', spec, { from: 0, to: 0 }).insert).toBe('plan:');
  });
});

describe('#283 round 2', () => {
  it('never stalls on a stray bracket inside a value group', () => {
    for (const q of ['action:([', 'action:(<', 'action:(a [ b)', 'action:({']) expect(queryCompletionAt(q, q.length).kind).toBeDefined();
  });

  it('takes no chip whose removal would change another term', () => {
    const q = '"category":"auth"-action:booked';
    expect(activityChip(q)).toBeUndefined();
    expect(activityFreeText(q)).toBe(q);
    expect(compileQuery(q).params).toMatchObject({ q1: '-action' });
  });

  it('counts the negation a group inherits, however many brackets wrap it', () => {
    expect(whoFilter('NOT ((impersonator:* outcome:failure))')).toBe('all');
    expect(removeTerm('NOT ((impersonator:* outcome:failure))', 'impersonator', '*', true)).toBe('NOT ((impersonator:* outcome:failure))');
    expect(whoFilter('NOT ((impersonator:*))')).toBe('self');
  });

  it('reads a quoted value joined with a colon part as one value, as the server does', () => {
    const q = '"category":"auth":other';
    const [token] = tokenize(q);
    expect(token).toMatchObject({ kind: 'field', field: 'category', value: 'auth:other', end: q.length });
    expect(compileQuery(q).params).toMatchObject({ q0: 'auth:other' });
    expect(queryCompletionAt(q, q.indexOf('auth') + 2)).toMatchObject({ kind: 'value', from: q.indexOf('"auth"'), to: q.length });
    const group = 'action:("book":"two words" OR cancel)';
    expect(queryCompletionAt(group, group.indexOf('book') + 2)).toMatchObject({ from: group.indexOf('"book"'), to: group.indexOf(' OR') });
  });

  it('completes stored keys that look like syntax with the explicit attr. prefix', () => {
    const spec = { id: 'k', kind: 'attr', badge: 'attr', group: 'Attributes' } as const;
    expect(keyItem(attributeQueryKey('attr.ticket status'), spec, { from: 0, to: 0 }).insert).toBe('"attr.attr.ticket status":');
    expect(attributeQueryKey('_exists_')).toBe('attr._exists_');
    expect(compileQuery('"attr.attr.ticket status":open').params).toMatchObject({ q0: 'attr.ticket status' });
    expect(compileQuery('attr._exists_:*').params).toMatchObject({ q0: '_exists_' });
  });
});

describe('#283 round 3', () => {
  it('replaces exactly the value the server reads, never an OR or a neighbour', () => {
    const joinedOr = 'action:"book":OR tenant:west';
    expect(queryCompletionAt(joinedOr, joinedOr.indexOf('book') + 2)).toMatchObject({ kind: 'value', from: 7, to: joinedOr.indexOf('OR') });
    const joinedQuote = 'action:book:"two words"';
    expect(queryCompletionAt(joinedQuote, 9)).toMatchObject({ kind: 'value', from: 7, to: joinedQuote.length });
    const quoteInMember = 'action:(ab"cd OR next) tenant:west';
    expect(queryCompletionAt(quoteInMember, quoteInMember.indexOf('tenant') + 1)).toMatchObject({ kind: 'key' });
    expect(queryCompletionAt(quoteInMember, quoteInMember.indexOf('next') + 2)).toMatchObject({
      kind: 'value',
      from: quoteInMember.indexOf('next'),
      to: quoteInMember.indexOf(')'),
    });
  });

  it('never includes or excludes a facet value by removing a term from inside NOT (a b)', () => {
    expect(excludeTerm('NOT (outcome:failure action:booked)', 'outcome', 'failure')).toBe('NOT (outcome:failure action:booked) -outcome:failure');
    expect(includeTerm('NOT (outcome:failure action:booked)', 'outcome', 'success')).toBe('NOT (outcome:failure action:booked) outcome:success');
  });

  it('reads no who-split from a term in one OR branch', () => {
    expect(whoFilter('NOT (impersonator:*) OR outcome:failure')).toBe('all');
    expect(whoFilter('-impersonator:* outcome:failure')).toBe('self');
  });
});

describe('#283 verification', () => {
  it('reads a quote inside a bare value as the server does, so Enter offers nothing that rewrites it', () => {
    const q = 'action:ab"cd';
    expect(queryCompletionAt(q, q.length)).toMatchObject({ kind: 'value', field: 'action', prefix: 'ab"cd', from: 7, to: q.length });
  });

  it("completes inside a quoted value's spaces as that value, never as a new field", () => {
    const q = 'action:book:"two tenant"';
    expect(queryCompletionAt(q, q.indexOf('tenant') + 3)).toMatchObject({ kind: 'value', field: 'action', from: 7, to: q.length });
    const after = 'action:(ab"cd OR next) attempt:>2';
    expect(queryCompletionAt(after, after.length)).toMatchObject({ kind: 'value', field: 'attempt', op: '>', from: after.length - 1 });
  });

  it('reads a who-split only from what every OR branch restricts, whatever the brackets', () => {
    expect(whoFilter('impersonator:amy OR impersonator:bea')).toBe('support');
    expect(whoFilter('(NOT (impersonator:*) OR outcome:failure)')).toBe('all');
    expect(whoFilter('((-impersonator:* outcome:failure))')).toBe('self');
    expect(whoFilter('-impersonator:* OR (NOT impersonator:* action:x)')).toBe('self');
    expect(whoFilter('NOT (impersonator:* OR impersonator:qa-agent-1)')).toBe('self');
    expect(whoFilter('(impersonator:* OR outcome:failure) action:x')).toBe('all');
  });
});
