// Chips, labels and editing keep a query's meaning (#220, items 11-15).
import { compileQuery } from '@logbird/clickhouse';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', () => ({ api: {} }));

import { editorQuery } from '@/components/query-input/query-input';
import { keyItem } from '@/components/query-input/use-completions';
import { activityChip, activityFreeText } from './activity-search';
import { whoFilter } from './impersonation';
import { presenceTerms } from './presence-filter';
import { fieldTerms, formatTerm, highlightQuery, queryCompletionAt, removeTerm, tokenize } from './query-language';
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
    const regex = 'action:(/booking updated/ OR cancel)';
    expect(queryCompletionAt(regex, regex.indexOf('updated') + 2)).toMatchObject({ from: regex.indexOf('/'), to: regex.indexOf(' OR') });
    const joined = 'action:(tag:"two words" OR ok)';
    expect(queryCompletionAt(joined, joined.indexOf('words') + 2)).toMatchObject({ from: joined.indexOf('tag'), to: joined.indexOf(' OR') });
  });

  it('quotes a discovered attribute key that is not a plain name when completing it', () => {
    const spec = { id: 'k', kind: 'attr', badge: 'attr', group: 'Attributes' } as const;
    expect(keyItem('ticket status', spec, { from: 0, to: 0 }).insert).toBe('"ticket status":');
    expect(keyItem('plan', spec, { from: 0, to: 0 }).insert).toBe('plan:');
  });
});
