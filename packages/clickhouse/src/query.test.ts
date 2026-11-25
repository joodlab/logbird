import { formatRecordTerm, quoteQueryValue } from '@logbird/contracts';
import { describe, expect, it } from 'vitest';
import { normalizeEvent } from './normalize';
import { compileQuery, parseQuery, QueryError } from './query';

const literalValues = ['a\tb', 'a\nb', 'a\rb', '"', '\\', ':', 'a b', ' surrounded ', '*', '(', ')', 'OR', 'العربية', '🦜'];

describe('query language', () => {
  it('round-trips generated exact field values through compilation', () => {
    for (const value of [...literalValues, 'team*', 'a*b', 'a*b*', 'a\\*']) {
      for (const field of ['actor', 'tenant', 'target']) {
        const q = `${field}:${quoteQueryValue(value)}`;
        expect(compileQuery(q).params, q).toEqual({ q0: value });
        expect(compileQuery(q).sql, q).toContain(' = {q0:String}');
      }
    }
  });

  it.each([
    [String.raw`tenant:team\*`, 'team*'],
    [String.raw`tenant:"team\*"`, 'team*'],
    [String.raw`tenant:\*`, '*'],
    [String.raw`tenant:"\*"`, '*'],
    [String.raw`tenant:team\*west`, 'team*west'],
    [String.raw`tenant:id:team\*`, 'id:team*'],
  ])('matches escaped stars exactly in %s', (q, value) => {
    expect(compileQuery(q)).toEqual({ sql: '(tenant_id = {q0:String})', params: { q0: value } });
  });

  it('retains unescaped wildcards in quoted values and mixed groups', () => {
    expect(compileQuery('tenant:"team*"')).toEqual(compileQuery('tenant:team*'));
    expect(compileQuery(String.raw`tenant:"team\\*"`)).toEqual({ sql: '(startsWith(tenant_id, {q0:String}))', params: { q0: 'team\\' } });
    expect(compileQuery(String.raw`tenant:(team\* OR "org*")`)).toEqual({
      sql: '((tenant_id = {q0:String}) OR (startsWith(tenant_id, {q1:String})))',
      params: { q0: 'team*', q1: 'org' },
    });
  });

  it('preserves backslashes in bare attribute keys', () => {
    expect(compileQuery(String.raw`attr.note\*:yes`).params).toEqual({ q0: 'note\\*', q1: 'yes' });
    expect(compileQuery(String.raw`_exists_:note\*`).params).toEqual({ q0: 'note\\*' });
  });

  it.each([
    [
      'action:hotel.* -env:staging',
      [
        { field: 'action', value: 'hotel.*', negate: false },
        { field: 'env', value: 'staging', negate: true },
      ],
    ],
    [
      'actor.name:"Raed B" "free text" bare',
      [
        { field: 'actor.name', value: 'Raed B', negate: false },
        { field: '', value: 'free text', negate: false },
        { field: '', value: 'bare', negate: false },
      ],
    ],
    ['actor.name:"a\\"b"', [{ field: 'actor.name', value: 'a"b', negate: false }]],
  ])('parses %s', (q, expected) =>
    expect(Object.values(compileQuery(q as string).params)).toEqual(
      (expected as { value: string }[]).map((t) => (t.value.endsWith('*') ? t.value.slice(0, -1) : t.value)),
    ),
  );
  it('rejects unterminated quotes', () => expect(() => parseQuery('actor:"oops')).toThrow());
  it('binds unknown keys and injection as values', () => {
    const c = compileQuery('weird\'key:"x\' OR 1=1 --"');
    expect(c.sql).not.toContain('weird');
    expect(c.sql).not.toContain('OR 1=1');
    expect(c.params).toEqual({ q0: "weird'key", q1: "x' OR 1=1 --" });
  });
  it.each([
    'id',
    'action',
    'outcome',
    'severity',
    'category',
    'actor',
    'actor.type',
    'tenant',
    'executor',
    'operation',
    'request',
    'trace',
    'source',
    'target',
    'target.type',
    'attr.metadata.plan',
  ])('compiles %s exact/prefix/negation', (field) => {
    expect(Object.values(compileQuery(`${field}:x`).params)).toContain('x');
    expect(compileQuery(`-${field}:x*`).sql).toContain('NOT');
    expect(Object.values(compileQuery(`${field}:x*`).params)).toContain('x');
  });
  it.each([
    ['impersonator:*', "(impersonator_id != '')"],
    ['actor:*', "(actor_id != '')"],
    ['tenant:*', "(tenant_id != '')"],
    ['executor:*', "(executor_id != '')"],
    ['parent:*', "(parent_event_id != '')"],
    ['job:*', "(job_id != '')"],
    ['actor.email:*', "(actor_email != '')"],
    ['target:*', "(arrayExists(x -> x != '', target_ids))"],
  ])('treats %s as "present and non-empty"', (q, sql) => {
    const c = compileQuery(q);
    expect(c.sql).toBe(sql);
    expect(c.params).toEqual({});
  });
  it('negated presence means "missing"', () => expect(compileQuery('-impersonator:*').sql).toBe("NOT ((impersonator_id != ''))"));
  it('attribute presence requires the key with a non-empty value', () => {
    const c = compileQuery('attr.metadata.plan:*');
    expect(c.sql).toBe("(mapContains(attributes,{q0:String}) AND (attributes[{q0:String}] != ''))");
    expect(c.params).toEqual({ q0: 'metadata.plan' });
    expect(compileQuery('plan:*').params).toEqual({ q0: 'plan' });
  });
  it('keeps non-empty prefixes as prefix matches', () => {
    const c = compileQuery('impersonator:usr_*');
    expect(c.sql).toBe('(startsWith(impersonator_id, {q0:String}))');
    expect(c.params).toEqual({ q0: 'usr_' });
  });
  it('keeps internal stars literal', () => expect(compileQuery('action:a*b').params.q0).toBe('a*b'));
});

describe('record selector', () => {
  it.each([
    ['record:site:12', 'site', '12'],
    ['record:order:A:1', 'order', 'A:1'],
    [String.raw`record:order\:archived:A1`, 'order:archived', 'A1'],
    [String.raw`record:"order\\:archived:A1"`, 'order:archived', 'A1'],
    [String.raw`record:order\\:A1`, 'order\\', 'A1'],
    ['record:page:/home/', 'page', '/home/'],
    ['record:"order:A:1"', 'order', 'A:1'],
    ['record:"page:home page"', 'page', 'home page'],
    ['record:page:OR', 'page', 'OR'],
    ['record:page:*', 'page', '*'],
    [String.raw`record:page:home\*`, 'page', 'home*'],
    [String.raw`record:"page\*:home\*"`, 'page*', 'home*'],
    [String.raw`record:"order:a\\b\"c"`, 'order', 'a\\b"c'],
  ])('matches a paired target with %s', (q, type, id) => {
    expect(compileQuery(q)).toEqual({
      sql: '(has(target_ids, {recordId0:String}) AND arrayExists((t, i) -> t = {recordType0:String} AND i = {recordId0:String}, target_types, target_ids))',
      params: { recordType0: type, recordId0: id },
    });
  });

  it('round-trips generated selectors across punctuation, whitespace and Unicode', () => {
    const types = ['order', 'order:archived', 'trailing\\', String.raw`slash\:colon`, '"a type"', 'مَلَفّ:📃', ':start', '/type/'];
    const ids = [...literalValues, 'A1', ':A:1', 'a\\b', 'a*b*', 'a\\*', '"quote" and space', '/home/', '(nested)'];
    for (const type of types) {
      for (const id of ids) {
        const q = formatRecordTerm(type, id);
        expect(compileQuery(q).params, q).toEqual({ recordType0: type, recordId0: id });
      }
    }
  });

  it('negates the whole group and binds distinct pairs', () => {
    const q = compileQuery('-record:(page:1 OR site:7)');
    expect(q.sql).toMatch(/^NOT \(.*arrayExists.* OR .*arrayExists.*\)$/);
    expect(q.params).toEqual({ recordType0: 'page', recordId0: '1', recordType1: 'site', recordId1: '7' });
  });

  it('supports presence and negated presence', () => {
    expect(compileQuery('record:*')).toEqual({ sql: '(notEmpty(target_ids))', params: {} });
    expect(compileQuery('NOT _exists_:record')).toEqual({ sql: 'NOT ((notEmpty(target_ids)))', params: {} });
  });

  it.each([
    ['record:', 'syntax', 7, 7],
    ['record:site', 'type', 7, 11],
    ['😀 record:"site"', 'type', 10, 16],
  ])('reports a helpful error span for %s', (q, reason, start, end) => {
    expect(() => compileQuery(q)).toThrow(
      expect.objectContaining({ details: { lang: 'query', reason, start, end, hint: expect.stringContaining('record:<type>:<id>') } }),
    );
  });
});

describe('normalization', () => {
  const ctx = { projectId: 'p', receivedAt: new Date('2026-11-04T00:00:00Z') };
  it('accepts empty action and malformed recommended fields', () => {
    const r = normalizeEvent({ action: '', actor: 123, outcome: 'custom' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row.outcome).toBe('custom');
      expect(r.id).toMatch(/^[\da-f-]{14}7/);
    }
  });
  it('preserves raw and flattens unknown nested fields', () => {
    const e = {
      action: ' hotel.updated ',
      metadata: { plan: { tier: 'pro' } },
      actor: { id: ' u ', extra: true },
      targets: [{ type: 'hotel', id: '1', custom: 'yes' }],
      changes: [{ field: 'x', before: 1, after: { a: true } }],
    };
    const r = normalizeEvent(e, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(r.row.payload)).toEqual(e);
      expect(r.row.attributes).toMatchObject({ 'metadata.plan.tier': 'pro', 'actor.extra': 'true', 'targets.0.custom': 'yes' });
      expect(r.row.actor_id).toBe('u');
      expect(r.row.changes_after).toEqual(['{"a":true}']);
    }
  });
  it('bounds attribute keys and values', () => {
    const r = normalizeEvent({ action: 'x', ...Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, 'a'.repeat(3000)])) }, ctx);
    expect(r.ok).toBe(false);
    const s = normalizeEvent({ action: 'x', ...Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, 'a'])) }, ctx);
    if (s.ok) expect(Object.keys(s.row.attributes)).toHaveLength(256);
  });
  it('scores recommended presence', () => {
    const r = normalizeEvent(
      {
        action: 'x',
        occurredAt: ctx.receivedAt.toISOString(),
        actor: { id: 'x', type: 'user' },
        outcome: 'success',
        targets: [{ type: 'x', id: '1' }],
        tenant: { id: 'x' },
        executor: { type: 'api' },
        context: { requestId: 'x' },
        description: 'x',
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.row.conformance).toBe(100);
  });
  it('keeps events with an unusable occurredAt at receive time, with a warning and the original value', () => {
    for (const occurredAt of [1_700_000_000, 'not a date', '2099-01-01T00:00:00Z', { at: 1 }]) {
      const r = normalizeEvent({ action: 'x', occurredAt }, ctx);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.warning).toMatch(/stored at receive time/);
      expect(new Date(r.row.timestamp).getTime()).toBe(ctx.receivedAt.getTime());
      expect(r.row.attributes['logbird.occurredAt.rejected']).toBeTruthy();
    }
    const ok = normalizeEvent({ action: 'x', occurredAt: ctx.receivedAt.toISOString() }, ctx);
    expect(ok.ok && ok.warning).toBe(null);
  });
  it.each([null, [], {}, { action: 1 }])('rejects no action %s', (input) => expect(normalizeEvent(input, ctx).ok).toBe(false));
});

it('bounds grammar and preserves quoted punctuation', () => {
  expect(compileQuery('a OR b').sql).toContain(' OR ');
  expect(compileQuery('(a)').params.q0).toBe('a');
  expect(() => parseQuery('x '.repeat(65))).toThrow('64');
  expect(() => parseQuery('a'.repeat(4097))).toThrow('4096');
  expect(parseQuery('"Hello: (world)"')).toEqual([{ kind: 'value', value: 'Hello: (world)', start: 0, end: 16 }]);
  expect(compileQuery('attr.empty:""').sql).toContain('mapContains');
  expect(compileQuery('__proto__:safe').params.q0).toBe('__proto__');
  expect(compileQuery('\u0645\u0631\u062d\u0628\u0627').sql).toContain('hasToken');
});

it.each([
  ['impersonator', 'impersonator_id'],
  ['actor.email', 'actor_email'],
  ['parent', 'parent_event_id'],
  ['tenant.name', 'tenant_name'],
  ['executor.name', 'executor_name'],
  ['job', 'job_id'],
])('maps %s to its core column', (field, column) => {
  expect(compileQuery(`${field}:value`).sql).toBe(`(${column} = {q0:String})`);
});
it('preserves boolean precedence and quoted operators', () => {
  expect(compileQuery('action:a OR (actor:b -tenant:c)').sql).toBe(
    '((action = {q0:String}) OR ((actor_id = {q1:String}) AND NOT ((tenant_id = {q2:String}))))',
  );
  expect(compileQuery('"OR"').params.q0).toBe('OR');
  expect(() => parseQuery(`${'('.repeat(17)}x${')'.repeat(17)}`)).toThrow('16');
  expect(() => parseQuery(`${'('.repeat(16)}x${')'.repeat(16)}`)).not.toThrow();
});
it.each(['OR a', 'a OR', 'a OR OR b', '()', '(a', 'a)', 'a ()'])('rejects malformed boolean grammar %s', (q) =>
  expect(() => parseQuery(q)).toThrow('Invalid query syntax'),
);

describe('server follow-ups', () => {
  it('accepts Lucene existence and negation for core and attribute fields', () => {
    for (const field of ['actor', 'metadata.plan', 'target.type']) {
      expect(compileQuery(`_exists_:${field}`)).toEqual(compileQuery(`${field}:*`));
      expect(compileQuery(`NOT _exists_:${field}`)).toEqual(compileQuery(`NOT ${field}:*`));
    }
  });
  it('binds relative times once per compilation and rounds in UTC', () => {
    const now = Date.parse('2026-11-05T12:34:56Z');
    expect(Object.values(compileQuery('occurredAt:[now-24h TO now]', now).params)).toEqual(['2026-11-04T12:34:56.000Z', '2026-11-05T12:34:56.000Z']);
    expect(Object.values(compileQuery('occurredAt:>now-7d/d', now).params)).toEqual(['2026-10-29T00:00:00.000Z']);
    for (const unit of ['s', 'm', 'h', 'd', 'w']) expect(compileQuery(`occurredAt:>now-1${unit}`, now).sql).not.toContain('now');
    expect(() => compileQuery('occurredAt:>now-1y')).toThrow();
  });
  it.each([
    ['actor = user', 'actor:user'],
    ['actor != user', '-actor:user'],
    ['!actor:user', '-actor:user'],
    ['a && b', 'a AND b'],
    ['a||b', 'a OR b'],
  ])('offers an exact replacement for %s', (q, fixed) => {
    try {
      compileQuery(q);
      throw new Error('Expected error');
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
      const r = (error as QueryError).details.replacement!;
      expect(q.slice(0, r.start) + r.text + q.slice(r.end)).toBe(fixed);
    }
  });
  it('keeps operators inside literals unchanged', () => {
    expect(Object.values(compileQuery('description:"x = y && !a:b"').params)).toEqual(['x = y && !a:b']);
  });
});

describe('change values and the impersonator name', () => {
  it('matches any element of the before and after arrays, like changes.field', () => {
    expect(compileQuery('changes.after:PUBLISHED')).toEqual({
      sql: '(arrayExists(x -> x = {q0:String}, changes_after))',
      params: { q0: 'PUBLISHED' },
    });
    expect(compileQuery('changes.before:DRAFT')).toEqual({ sql: '(arrayExists(x -> x = {q0:String}, changes_before))', params: { q0: 'DRAFT' } });
    expect(compileQuery('changes.after:PUB*').sql).toBe('(arrayExists(x -> startsWith(x, {q0:String}), changes_after))');
    expect(compileQuery('changes.before:*').sql).toBe("(arrayExists(x -> x != '', changes_before))");
    expect(compileQuery('changes.after:(A OR B)').sql).toBe(
      '((arrayExists(x -> x = {q0:String}, changes_after)) OR (arrayExists(x -> x = {q1:String}, changes_after)))',
    );
    // An empty quoted value matches a change whose value was absent (stored as empty text).
    expect(compileQuery('changes.before:""')).toEqual({ sql: '(arrayExists(x -> x = {q0:String}, changes_before))', params: { q0: '' } });
    expect(() => compileQuery('changes.after:>2')).toThrow(/does not support comparisons/);
  });

  it('reads the impersonator name column', () => {
    expect(compileQuery('impersonator.name:"Rita Support"')).toEqual({ sql: '(impersonator_name = {q0:String})', params: { q0: 'Rita Support' } });
    expect(compileQuery('impersonator.name:(a OR b)').sql).toBe('(impersonator_name IN ({q0:String},{q1:String}))');
  });

  it.each([
    'changes.to:PUBLISHED',
    'changes.value:x',
    'changes:x',
    '_exists_:changes.new',
    'NOT changes.from:DRAFT',
    'action:x OR changes.Field:status',
  ])('refuses %s: changes are never attributes, so it could only ever match nothing', (q) => {
    try {
      compileQuery(q);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
      const details = (error as QueryError).details;
      expect(details).toMatchObject({ lang: 'query', reason: 'unknown_field' });
      expect(details.hint).toMatch(/changes\.field, changes\.before or changes\.after/);
      expect(q.slice(details.start ?? 0, details.end ?? 0)).toMatch(/changes/);
    }
  });

  it('keeps explicit attribute lookups and the other changes fields', () => {
    expect(compileQuery('attr.changes.to:x').params).toEqual({ q0: 'changes.to', q1: 'x' });
    expect(compileQuery('changes.field:status').sql).toBe('(arrayExists(x -> x = {q0:String}, changes_fields))');
    // impersonator.* other than name stays an attribute (impersonator.email, impersonator.type).
    expect(compileQuery('impersonator.type:user').params).toEqual({ q0: 'impersonator.type', q1: 'user' });
  });
});
