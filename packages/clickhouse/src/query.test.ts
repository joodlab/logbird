import { describe, expect, it } from 'vitest';
import { normalizeEvent } from './normalize';
import { compileQuery, parseQuery, QueryError } from './query';

describe('query language', () => {
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
      expect(r.row.attributes['trailmark.occurredAt.rejected']).toBeTruthy();
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
