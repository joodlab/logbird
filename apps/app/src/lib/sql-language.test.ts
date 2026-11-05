import { describe, expect, it } from 'vitest';
import { sqlColumn } from './query-catalog';
import { translateQueryToSql } from './query-translate';
import {
  appendSqlPredicate,
  hasSqlPredicate,
  highlightSql,
  sqlCompletionAt,
  sqlConjuncts,
  sqlString,
  toggleSqlPredicate,
  tokenizeSql,
} from './sql-language';

const suggestFieldFor = (column: string) => sqlColumn(column)?.suggestField;
const classes = (q: string) =>
  highlightSql(q)
    .filter((s) => s.cls !== 'plain')
    .map((s) => `${q.slice(s.start, s.end)}:${s.cls}`);

describe('tokenizeSql / highlightSql', () => {
  it('is lossless', () => {
    const q = "job_attempt > 2 AND attributes['metadata.channel'] = 'whatsapp' -- note\n OR x IN ('a', 'it''s')";
    expect(
      tokenizeSql(q)
        .map((t) => t.raw)
        .join(''),
    ).toBe(q);
  });

  it('flags unknown columns, disallowed functions and forbidden clauses', () => {
    expect(classes("job_attempt > 2 AND foo = 'x'")).toEqual([
      'job_attempt:ident',
      '>:operator',
      '2:number',
      'AND:keyword',
      'foo:unknown',
      '=:operator',
      "'x':string",
    ]);
    expect(classes('has(target_types, sleep(1))')).toEqual([
      'has:function',
      '(:punct',
      'target_types:ident',
      ',:punct',
      'sleep:unknown',
      '(:punct',
      '1:number',
      '):punct',
      '):punct',
    ]);
    expect(classes('action IN (SELECT 1)')).toContain('SELECT:unknown');
  });

  it('accepts lambda parameters and CAST type names', () => {
    expect(classes("arrayExists(x -> startsWith(x, 'bk_'), target_ids)").filter((c) => c.endsWith(':unknown'))).toEqual([]);
    expect(classes('CAST(job_attempt AS String) = 2').filter((c) => c.endsWith(':unknown'))).toEqual([]);
  });

  it('treats function names case-insensitively but columns case-sensitively', () => {
    expect(classes('LOWER(action)')).toEqual(['LOWER:function', '(:punct', 'action:ident', '):punct']);
    expect(classes('ACTION')).toEqual(['ACTION:unknown']);
  });
});

describe('sqlCompletionAt', () => {
  it('completes identifiers and functions', () => {
    expect(sqlCompletionAt('job_att', 7, suggestFieldFor)).toEqual({ kind: 'ident', prefix: 'job_att', from: 0, to: 7 });
    expect(sqlCompletionAt('a = 1 AND ', 10, suggestFieldFor)).toEqual({ kind: 'ident', prefix: '', from: 10, to: 10 });
    expect(sqlCompletionAt('has(', 4, suggestFieldFor)).toEqual({ kind: 'ident', prefix: '', from: 4, to: 4 });
  });

  it('stays closed after a comparison operator, number or string', () => {
    expect(sqlCompletionAt('job_attempt > ', 14, suggestFieldFor)).toEqual({ kind: 'none' });
    expect(sqlCompletionAt('job_attempt > 2', 15, suggestFieldFor)).toEqual({ kind: 'none' });
    expect(sqlCompletionAt("action = 'x'", 12, suggestFieldFor)).toEqual({ kind: 'none' });
  });

  it("completes attribute keys inside attributes['…", () => {
    expect(sqlCompletionAt("attributes['meta", 16, suggestFieldFor)).toEqual({
      kind: 'attrKey',
      prefix: 'meta',
      from: 12,
      to: 16,
      closeQuote: true,
      closeBracket: true,
    });
    expect(sqlCompletionAt("attributes['meta'] = 'x'", 14, suggestFieldFor)).toMatchObject({
      kind: 'attrKey',
      prefix: 'me',
      to: 16,
      closeQuote: false,
      closeBracket: false,
    });
  });

  it('completes values compared with a column', () => {
    expect(sqlCompletionAt("actor_name = 'Ra", 16, suggestFieldFor)).toEqual({
      kind: 'value',
      field: 'actor.name',
      column: 'actor_name',
      prefix: 'Ra',
      from: 14,
      to: 16,
      closeQuote: true,
    });
    expect(sqlCompletionAt("outcome IN ('failure', 'de", 26, suggestFieldFor)).toMatchObject({ kind: 'value', field: 'outcome', prefix: 'de' });
    expect(sqlCompletionAt("has(target_types, 'bo", 21, suggestFieldFor)).toMatchObject({ kind: 'value', field: 'target.type', prefix: 'bo' });
    expect(sqlCompletionAt("attributes['metadata.channel'] = 'wh", 36, suggestFieldFor)).toMatchObject({
      kind: 'value',
      field: 'attr.metadata.channel',
      prefix: 'wh',
    });
    // Columns without a suggestion source stay quiet.
    expect(sqlCompletionAt("request_id = 'r", 15, suggestFieldFor)).toEqual({ kind: 'none' });
  });
});

describe('predicates', () => {
  it('escapes string literals', () => {
    expect(sqlString("it's \\ ok")).toBe("'it\\'s \\\\ ok'");
  });

  it('splits top-level AND conjuncts only', () => {
    expect(sqlConjuncts('a = 1 AND (b = 2 OR c = 3) AND x BETWEEN 1 AND 5')).toEqual(['a = 1', '(b = 2 OR c = 3)', 'x BETWEEN 1 AND 5']);
    expect(sqlConjuncts('a = 1 OR b = 2')).toEqual(['a = 1 OR b = 2']);
    expect(sqlConjuncts('  ')).toEqual([]);
  });

  it('appends with AND and parenthesises a top-level OR', () => {
    expect(appendSqlPredicate('', "outcome = 'failure'")).toBe("outcome = 'failure'");
    expect(appendSqlPredicate('a = 1 OR b = 2', "outcome = 'failure'")).toBe("(a = 1 OR b = 2) AND outcome = 'failure'");
    expect(appendSqlPredicate("outcome = 'failure'", "outcome = 'failure'")).toBe("outcome = 'failure'");
  });

  it('toggles facet predicates', () => {
    const q = toggleSqlPredicate("job_attempt > 2 AND outcome = 'failure'", "outcome = 'denied'", 'outcome', 'include');
    expect(q).toBe("job_attempt > 2 AND outcome = 'denied'");
    expect(hasSqlPredicate(q, "outcome = 'denied'")).toBe(true);
    expect(toggleSqlPredicate(q, "outcome = 'denied'", 'outcome', 'include')).toBe('job_attempt > 2');
    const ex = toggleSqlPredicate(toggleSqlPredicate('', "action != 'a'", 'action', 'exclude'), "action != 'b'", 'action', 'exclude');
    expect(ex).toBe("action != 'a' AND action != 'b'");
  });
});

describe('translateQueryToSql', () => {
  it('translates simple terms', () => {
    expect(translateQueryToSql('')).toBe('');
    expect(translateQueryToSql('outcome:failure -env:staging')).toBe("outcome = 'failure' AND NOT environment = 'staging'");
    expect(translateQueryToSql('action:booking.*')).toBe("startsWith(action, 'booking.')");
    expect(translateQueryToSql('actor.name:"Raed B" target.type:booking')).toBe("actor_name = 'Raed B' AND has(target_types, 'booking')");
    expect(translateQueryToSql('impersonator:* -tenant:*')).toBe("impersonator_id != '' AND NOT tenant_id != ''");
  });

  it('translates v2 comparisons, ranges, regexes and groups', () => {
    expect(translateQueryToSql('attempt:>2')).toBe('job_attempt > 2');
    expect(translateQueryToSql('attempt:[2 TO 5}')).toBe('(job_attempt >= 2 AND job_attempt < 5)');
    expect(translateQueryToSql('metadata.channel:whatsapp')).toBe("attributes['metadata.channel'] = 'whatsapp'");
    expect(translateQueryToSql('duration_ms:>100')).toBe("toFloat64OrNull(attributes['duration_ms']) > 100");
    expect(translateQueryToSql('action:/booking\\.(created|cancelled)/')).toBe("match(action, '^(?:booking\\\\.(created|cancelled))$')");
    expect(translateQueryToSql('-outcome:(failure OR denied)')).toBe("NOT outcome IN ('failure', 'denied')");
    expect(translateQueryToSql('(action:a OR action:b) NOT severity:info')).toBe("(action = 'a' OR action = 'b') AND NOT severity = 'info'");
  });

  it('gives up on free text and the description field', () => {
    expect(translateQueryToSql('outcome:failure refund')).toBeNull();
    expect(translateQueryToSql('"free text"')).toBeNull();
    expect(translateQueryToSql('description:refund')).toBeNull();
    expect(translateQueryToSql('outcome:>2')).toBeNull();
  });
});
