import { compileQuery } from '@logbird/clickhouse';
import { formatRecordTerm } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import { scopedQueryProblem } from './query-error';
import { andQuery, formatTerm, hasTopLevelOr, scopedQuery } from './query-language';

// Every locked filter an entity page builds: a record pair, an actor, a tenant, an executor.
const bases = [formatRecordTerm('site', '12'), formatTerm('actor', 'u_1'), formatTerm('tenant', 't_1'), formatTerm('executor', 'crm-worker')];

describe('scopedQuery: entity filter AND the reader query', () => {
  it('keeps a valid top-level OR inside one group: base AND (a OR b)', () => {
    for (const base of bases) {
      const scoped = scopedQuery(base, 'outcome:failure OR action:x');
      expect(scoped.problem).toBeNull();
      expect(scoped.q).toBe(`${base} (outcome:failure OR action:x)`);
      // The server compiles it as the base ANDed with the whole group, never (base AND a) OR b.
      expect(hasTopLevelOr(scoped.q ?? '')).toBe(false);
      const sql = compileQuery(scoped.q ?? '').sql;
      expect(sql.startsWith(`${compileQuery(base).sql} AND (`)).toBe(true);
    }
  });

  it('keeps a negated group inside the base', () => {
    for (const base of bases) {
      const scoped = scopedQuery(base, '-(outcome:failure OR action:x)');
      expect(scoped.q).toBe(`${base} (-(outcome:failure OR action:x))`);
      expect(hasTopLevelOr(scoped.q ?? '')).toBe(false);
      expect(compileQuery(scoped.q ?? '').sql.startsWith(`${compileQuery(base).sql} AND `)).toBe(true);
    }
  });

  it('never combines a query that does not parse: leading OR, unbalanced parentheses', () => {
    for (const base of bases)
      for (const user of ['OR outcome:failure', 'outcome:failure) OR (action:x', '(outcome:failure OR action:x', 'outcome:failure)']) {
        const scoped = scopedQuery(base, user);
        expect(scoped, `${base} + ${user}`).toMatchObject({ q: null, problem: expect.any(Error) });
      }
    // What plain concatenation did before: a leading OR became a top-level OR that escapes the record.
    expect(hasTopLevelOr(andQuery(bases[0] ?? '', 'OR outcome:failure'))).toBe(true);
  });

  it('leaves an empty side alone', () => {
    expect(scopedQuery(bases[0] ?? '', '  ')).toEqual({ q: bases[0], offset: 0, problem: null });
    // The reader's query alone is sent exactly as typed.
    expect(scopedQuery('', '  outcome:failure ')).toEqual({ q: '  outcome:failure ', offset: 0, problem: null });
  });

  it("reports the reader's own parse error, and maps server positions back onto the reader's text", () => {
    const blocked = scopedQuery(bases[0] ?? '', 'outcome:failure)');
    expect(scopedQueryProblem(blocked, null)).toMatchObject({ code: 'invalid_query', details: { reason: 'syntax' } });
    const scoped = scopedQuery('tenant:t_1', 'severity:loud');
    const server = {
      code: 'invalid_query' as const,
      message: 'Invalid value',
      details: { lang: 'query' as const, reason: 'type' as const, start: 'tenant:t_1 ('.length + 9, end: 'tenant:t_1 ('.length + 13, hint: null },
    };
    expect(scopedQueryProblem(scoped, server)?.details).toMatchObject({ start: 9, end: 13 });
    // A position inside the locked filter has no place in the reader's text.
    expect(scopedQueryProblem(scoped, { ...server, details: { ...server.details, start: 2, end: 4 } })?.details).toMatchObject({
      start: null,
      end: null,
    });
  });
});
