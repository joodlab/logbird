import { describe, expect, it } from 'vitest';
import { normalizeEvent } from './normalize';
import { compileQuery, parseQuery } from './query';

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
  ])('parses %s', (q, expected) => expect(parseQuery(q as string)).toEqual(expected));
  it('rejects unterminated quotes', () => expect(() => parseQuery('actor:"oops')).toThrow());
  it('binds unknown keys and injection as values', () => {
    const c = compileQuery('weird\'key:"x\' OR 1=1 --"');
    expect(c.sql).not.toContain('weird');
    expect(c.sql).not.toContain('OR 1=1');
    expect(c.params).toEqual({ q0k: "weird'key", q0: "x' OR 1=1 --" });
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
    expect(compileQuery(`${field}:x`).params.q0).toBe('x');
    expect(compileQuery(`-${field}:x*`).sql).toContain('NOT');
    expect(compileQuery(`${field}:x*`).params.q0).toBe('x');
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
        occurredAt: 1,
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
    if (r.ok) expect(r.row.conformance).toBe(100);
  });
  it.each([null, [], {}, { action: 1 }])('rejects no action %s', (input) => expect(normalizeEvent(input, ctx).ok).toBe(false));
});
