import { compileQuery } from '@logbird/clickhouse';
import { formatRecordTerm, QUERY_FIELDS } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import { sqlColumn } from './query-catalog';
import { translateQueryToSql } from './query-translate';
import {
  appendSqlPredicate,
  hasSqlPredicate,
  highlightSql,
  sqlCallAt,
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

  it('marks unterminated strings and quoted attribute keys as open', () => {
    const open = tokenizeSql("attributes['metadata.ch").find((t) => t.kind === 'string');
    expect(open).toMatchObject({ raw: "'metadata.ch", closed: false });
    const closed = tokenizeSql("action = 'it''s'").find((t) => t.kind === 'string');
    expect(closed).toMatchObject({ raw: "'it''s'", closed: true });
  });

  it('keeps offsets exact and splits operators from operands without spaces', () => {
    const q = "job_attempt>=2 AND outcome IN('failure')";
    const solid = tokenizeSql(q).filter((t) => t.kind !== 'space');
    expect(solid.map((t) => [t.kind, t.raw])).toEqual([
      ['ident', 'job_attempt'],
      ['operator', '>='],
      ['number', '2'],
      ['keyword', 'AND'],
      ['ident', 'outcome'],
      ['keyword', 'IN'],
      ['punct', '('],
      ['string', "'failure'"],
      ['punct', ')'],
    ]);
    for (const t of solid) expect(q.slice(t.start, t.end)).toBe(t.raw);
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

  it('offers comparison operators after a column and AND / OR after an operand', () => {
    expect(sqlCompletionAt('job_attempt ', 12, suggestFieldFor)).toEqual({
      kind: 'ident',
      prefix: '',
      from: 12,
      to: 12,
      after: 'column',
      column: 'job_attempt',
    });
    expect(sqlCompletionAt("attributes['metadata.queue'] ", 29, suggestFieldFor)).toMatchObject({
      kind: 'ident',
      after: 'column',
      column: "attributes['metadata.queue']",
    });
    expect(sqlCompletionAt('job_attempt > 2 ', 16, suggestFieldFor)).toMatchObject({ kind: 'ident', prefix: '', after: 'operand' });
    expect(sqlCompletionAt("action = 'x' AN", 15, suggestFieldFor)).toMatchObject({ kind: 'ident', prefix: 'AN', from: 13, after: 'operand' });
    expect(sqlCompletionAt('(a = 1 OR b = 2) ', 17, suggestFieldFor)).toMatchObject({ kind: 'ident', after: 'operand' });
    expect(sqlCompletionAt('timestamp > now() - INTERVAL 7 DAY ', 35, suggestFieldFor)).toMatchObject({ kind: 'ident', after: 'operand' });
    expect(sqlCompletionAt('impersonator_id IS NULL ', 24, suggestFieldFor)).toMatchObject({ kind: 'ident', after: 'operand' });
  });

  it('waits for a space after a literal, and explains operands without suggestions', () => {
    expect(sqlCompletionAt('job_attempt > 2', 15, suggestFieldFor)).toEqual({ kind: 'none' });
    expect(sqlCompletionAt("action = 'x'", 12, suggestFieldFor)).toEqual({ kind: 'none' });
    expect(sqlCompletionAt('job_attempt > ', 14, suggestFieldFor)).toEqual({ kind: 'operand', column: 'job_attempt' });
  });

  it('completes at the caret in the middle of a longer expression', () => {
    const q = "outcome = 'failure' AND job_att > 2";
    // Renaming the second column touches only that identifier.
    expect(sqlCompletionAt(q, 31, suggestFieldFor)).toMatchObject({ kind: 'ident', prefix: 'job_att', from: 24, to: 31 });
    expect(sqlCompletionAt(q, 31, suggestFieldFor)).not.toHaveProperty('after');
    // Back inside the first string: values for that column, closing quote already present.
    expect(sqlCompletionAt(q, 13, suggestFieldFor)).toMatchObject({ kind: 'value', field: 'outcome', prefix: 'fa', closeQuote: false });
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

  it('offers whole literals before the quote is typed (after =, IN ( and has(col, )', () => {
    expect(sqlCompletionAt('outcome = ', 10, suggestFieldFor)).toEqual({
      kind: 'value',
      field: 'outcome',
      column: 'outcome',
      prefix: '',
      from: 10,
      to: 10,
      closeQuote: true,
      openQuote: true,
    });
    expect(sqlCompletionAt('outcome IN (', 12, suggestFieldFor)).toMatchObject({ kind: 'value', field: 'outcome', openQuote: true });
    expect(sqlCompletionAt("outcome NOT IN ('failure', ", 27, suggestFieldFor)).toMatchObject({ kind: 'value', field: 'outcome', openQuote: true });
    expect(sqlCompletionAt('has(target_types, ', 18, suggestFieldFor)).toMatchObject({ kind: 'value', field: 'target.type', openQuote: true });
    expect(sqlCompletionAt("attributes['metadata.queue'] = ", 31, suggestFieldFor)).toMatchObject({
      kind: 'value',
      field: 'attr.metadata.queue',
      openQuote: true,
    });
  });

  it('keeps searching values when a bare word is typed where a value belongs', () => {
    expect(sqlCompletionAt('tenant_id = rawd', 16, suggestFieldFor)).toEqual({
      kind: 'value',
      field: 'tenant',
      column: 'tenant_id',
      prefix: 'rawd',
      from: 12,
      to: 16,
      closeQuote: true,
      openQuote: true,
    });
    // A complete allowed column on the right-hand side is still a column (column = column comparisons).
    expect(sqlCompletionAt('tenant_id = actor_id', 20, suggestFieldFor)).toMatchObject({ kind: 'ident', prefix: 'actor_id' });
  });
});

describe('sqlCallAt (signature help)', () => {
  it('finds the innermost call and the argument index', () => {
    expect(sqlCallAt("has(target_types, 'bo", 21)).toEqual({ name: 'has', arg: 1 });
    expect(sqlCallAt('has(', 4)).toEqual({ name: 'has', arg: 0 });
    expect(sqlCallAt('arrayExists(x -> startsWith(x, ', 31)).toEqual({ name: 'startsWith', arg: 1 });
    expect(sqlCallAt("toFloat64OrNull(attributes['a']) > 2", 30)).toEqual({ name: 'toFloat64OrNull', arg: 0 });
  });

  it('ignores IN lists, brackets and closed calls', () => {
    expect(sqlCallAt("outcome IN ('a', ", 17)).toBeNull();
    expect(sqlCallAt('has(a, b) AND ', 14)).toBeNull();
    expect(sqlCallAt("lower(outcome) IN ('a', ", 24)).toBeNull();
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

  it('never stacks parentheses when predicates come and go', () => {
    const base = 'job_attempt > 1 OR conformance < 50';
    const added = toggleSqlPredicate(base, "severity = 'warning'", 'severity', 'include');
    expect(added).toBe("(job_attempt > 1 OR conformance < 50) AND severity = 'warning'");
    const removed = toggleSqlPredicate(added, "severity = 'warning'", 'severity', 'include');
    expect(removed).toBe(base);
    expect(appendSqlPredicate('(a = 1 OR b = 2)', 'c = 3')).toBe('(a = 1 OR b = 2) AND c = 3');
    expect(appendSqlPredicate('(a = 1) OR (b = 2)', 'c = 3')).toBe('((a = 1) OR (b = 2)) AND c = 3');
  });

  it('toggles facet predicates', () => {
    const q = toggleSqlPredicate("job_attempt > 2 AND outcome = 'failure'", "outcome = 'denied'", 'outcome', 'include');
    expect(q).toBe("job_attempt > 2 AND outcome = 'denied'");
    expect(hasSqlPredicate(q, "outcome = 'denied'")).toBe(true);
    expect(toggleSqlPredicate(q, "outcome = 'denied'", 'outcome', 'include')).toBe('job_attempt > 2');
    const ex = toggleSqlPredicate(toggleSqlPredicate('', "action != 'a'", 'action', 'exclude'), "action != 'b'", 'action', 'exclude');
    expect(ex).toBe("action != 'a' AND action != 'b'");
  });

  it('compares predicate literals exactly when checking and toggling filters', () => {
    const oneSpace = "NOT has(target_ids, 'page:A B')";
    const twoSpaces = "NOT has(target_ids, 'page:A  B')";
    expect(hasSqlPredicate(oneSpace, twoSpaces)).toBe(false);
    expect(hasSqlPredicate("outcome  =\n'failure'", "outcome = 'failure'")).toBe(true);
    const included = toggleSqlPredicate(oneSpace, twoSpaces, 'target_ids', 'exclude');
    expect(included).toBe(`${oneSpace} AND ${twoSpaces}`);
    expect(toggleSqlPredicate(included, twoSpaces, 'target_ids', 'exclude')).toBe(oneSpace);
  });
});

describe('translateQueryToSql', () => {
  it('translates simple terms', () => {
    expect(translateQueryToSql('')).toBe('');
    expect(translateQueryToSql('outcome:failure -env:staging')).toBe("outcome = 'failure' AND NOT environment = 'staging'");
    expect(translateQueryToSql('action:booking.*')).toBe("startsWith(action, 'booking.')");
    expect(translateQueryToSql('actor.name:"Omar N" target.type:booking')).toBe("actor_name = 'Omar N' AND has(target_types, 'booking')");
    expect(translateQueryToSql('impersonator:* -tenant:*')).toBe("impersonator_id != '' AND NOT tenant_id != ''");
  });

  it('translates v2 comparisons, ranges, regexes and groups', () => {
    expect(translateQueryToSql('attempt:>2')).toBe('job_attempt > 2');
    expect(translateQueryToSql('attempt:[2 TO 5}')).toBe('(job_attempt >= 2 AND job_attempt < 5)');
    expect(translateQueryToSql('metadata.channel:whatsapp')).toBe(
      "(mapContains(attributes, 'metadata.channel') AND attributes['metadata.channel'] = 'whatsapp')",
    );
    expect(translateQueryToSql('duration_ms:>100')).toBe("toFloat64OrNull(attributes['duration_ms']) > 100");
    expect(translateQueryToSql('action:/booking\\.(created|cancelled)/')).toBe("match(action, '^(?:booking\\\\.(created|cancelled))$')");
    expect(translateQueryToSql('-outcome:(failure OR denied)')).toBe("NOT outcome IN ('failure', 'denied')");
    expect(translateQueryToSql('(action:a OR action:b) NOT severity:info')).toBe("(action = 'a' OR action = 'b') AND NOT severity = 'info'");
  });

  it('translates exact record pairs, presence and grouped negation', () => {
    expect(translateQueryToSql('record:"order:A:1"')).toBe(
      "(has(target_ids, 'A:1') AND arrayExists((t, i) -> t = 'order' AND i = 'A:1', target_types, target_ids))",
    );
    expect(translateQueryToSql('-record:(site:12 OR "page:home ( OR ) page")')).toBe(
      "NOT ((has(target_ids, '12') AND arrayExists((t, i) -> t = 'site' AND i = '12', target_types, target_ids)) OR (has(target_ids, 'home ( OR ) page') AND arrayExists((t, i) -> t = 'page' AND i = 'home ( OR ) page', target_types, target_ids)))",
    );
    expect(translateQueryToSql('NOT _exists_:record')).toBe('NOT notEmpty(target_ids)');
    expect(translateQueryToSql('record:site')).toBeNull();
    expect(translateQueryToSql('record:"site:12')).toBeNull();
    expect(translateQueryToSql('record:(/site:12/)')).toBeNull();
  });

  it.each(QUERY_FIELDS.filter((field) => field.type === 'array'))('matches compiler presence for $key', ({ key, column }) => {
    const presence = `arrayExists(x -> x != '', ${column})`;
    for (const term of [`${key}:*`, `${key}:"*"`, `_exists_:${key}`, `_exists_:"${key}"`]) {
      expect(compileQuery(term).sql).toBe(`(${presence})`);
      expect(translateQueryToSql(term)).toBe(presence);
      expect(translateQueryToSql(`NOT ${term}`)).toBe(`NOT ${presence}`);
      expect(translateQueryToSql(`-${term}`)).toBe(`NOT ${presence}`);
    }
    expect(translateQueryToSql(`${key}:(value OR "*")`)).toBe(`(has(${column}, 'value') OR ${presence})`);
  });

  it.each([
    [String.raw`_exists_:attr.tag\*`, String.raw`tag\*`],
    [String.raw`_exists_:"attr.tag\*"`, 'tag*'],
  ])('uses the same escaped attribute key for %s in both modes', (q, field) => {
    const compiled = compileQuery(q);
    expect(compiled.params).toEqual({ q0: field });
    const key = sqlString(field);
    expect(translateQueryToSql(q)).toBe(`(mapContains(attributes, ${key}) AND attributes[${key}] != '')`);
  });

  it('preserves presence alongside exact records and on scalar or attribute filters', () => {
    const q = 'record:page:7 target.name:"*"';
    expect(translateQueryToSql(q)).toBe(
      "(has(target_ids, '7') AND arrayExists((t, i) -> t = 'page' AND i = '7', target_types, target_ids)) AND arrayExists(x -> x != '', target_names)",
    );
    expect(translateQueryToSql('record:*')).toBe('notEmpty(target_ids)');
    expect(translateQueryToSql('_exists_:"record"')).toBe('notEmpty(target_ids)');
    expect(translateQueryToSql('attempt:* NOT _exists_:"timestamp"')).toBe('1 = 1 AND NOT 1 = 1');
    expect(translateQueryToSql('-_exists_:"metadata.plan"')).toBe(
      "NOT (mapContains(attributes, 'metadata.plan') AND attributes['metadata.plan'] != '')",
    );
  });

  it.each([
    ['attr.note:""', "attributes['note'] = ''"],
    ['attr.note:/a*/', "match(attributes['note'], '^(?:a*)$')"],
    ['attr.note:("" OR other)', "attributes['note'] IN ('', 'other')"],
    ['attributes.note:("" OR prefix*)', "(attributes['note'] = '' OR startsWith(attributes['note'], 'prefix'))"],
    ['attr.note:*', "attributes['note'] != ''"],
  ])('requires an existing attribute for %s, including when negated', (q, valuePredicate) => {
    const sql = `(mapContains(attributes, 'note') AND ${valuePredicate})`;
    expect(translateQueryToSql(q)).toBe(sql);
    expect(translateQueryToSql(`NOT ${q}`)).toBe(`NOT ${sql}`);
  });

  it.each([
    [String.raw`tenant:team\*`, "tenant_id = 'team*'"],
    [String.raw`tenant:"team\*"`, "tenant_id = 'team*'"],
    [String.raw`target:(team\* OR "org*")`, "(has(target_ids, 'team*') OR arrayExists(x -> startsWith(x, 'org'), target_ids))"],
    ['tenant:"team*"', "startsWith(tenant_id, 'team')"],
  ])('translates wildcard and literal stars in %s', (q, sql) => {
    expect(translateQueryToSql(q)).toBe(sql);
  });

  it.each([
    ['record: page:7', 'page', '7'],
    ['record \t:  page:7', 'page', '7'],
    ['record: "!page:7"', '!page', '7'],
    ['record:page:/home/', 'page', '/home/'],
    [String.raw`record:page:/a\d+.*/`, 'page', String.raw`/a\d+.*/`],
    ['record:page:home*', 'page', 'home*'],
    ['record:page:*', 'page', '*'],
    ['record:"page:section(2)"', 'page', 'section(2)'],
    ['record:"page:/home/(.*)/"', 'page', '/home/(.*)/'],
    [String.raw`record:order\:archived:A1`, 'order:archived', 'A1'],
    [formatRecordTerm('نَوْع:\\', 'مُعرِّف🪴 "a"'), 'نَوْع:\\', 'مُعرِّف🪴 "a"'],
    [formatRecordTerm('page:section\\v2', ' x\t\n\r:y"\\ '), 'page:section\\v2', ' x\t\n\r:y"\\ '],
  ])('translates the same literal pair as the compiler for %s', (q, type, id) => {
    const compiled = compileQuery(q);
    expect(compiled.params).toEqual({ recordType0: type, recordId0: id });
    const sql = compiled.sql.replace(/\{(recordType0|recordId0):String\}/g, (_, key) => sqlString(String(compiled.params[key])));
    expect(translateQueryToSql(q)).toBe(sql);
  });

  it.each([
    ['action :  "page  updated"', { q0: 'page  updated' }, "action = 'page  updated'"],
    ['attempt: >= 2', { q0: 2 }, 'job_attempt >= 2'],
    ['actor: user:7', { q0: 'user:7' }, "actor_id = 'user:7'"],
  ])('translates spaced values according to the compiler for %s', (q, params, sql) => {
    expect(compileQuery(q).params).toEqual(params);
    expect(translateQueryToSql(q)).toBe(sql);
  });

  it.each([
    'record:!page:7',
    'record: !page:7',
    'record: (page:8 OR !page:7)',
    'env: !tenant:7',
    'env:(prod OR !tenant:7)',
    'env:AND',
    'attempt: >= -2',
    'action:a&&env:prod',
    'NOT',
    'record:page:7 OR',
    '_exists_:"record',
    '_exists_:record:page',
  ])('rejects invalid query syntax consistently for %s', (q) => {
    expect(() => compileQuery(q)).toThrow();
    expect(translateQueryToSql(q)).toBeNull();
  });

  it('gives up on free text and the description field', () => {
    expect(translateQueryToSql('outcome:failure refund')).toBeNull();
    expect(translateQueryToSql('"free text"')).toBeNull();
    expect(translateQueryToSql('description:refund')).toBeNull();
    expect(translateQueryToSql('outcome:>2')).toBeNull();
  });
});
