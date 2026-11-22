import { readScopeSchema } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { normalizeEvent } from './normalize';
import { recordTargetPredicate } from './query';
import { scopeFingerprint, scopePredicate } from './scope';
import { pairedTargetSql } from './target-pair';

it('#180 decision: only surrounding whitespace can make two sent ids share a stored id that a scope can name', () => {
  const stored = (sent: string) => {
    const result = normalizeEvent(
      { action: 'a', tenant: { id: sent }, targets: [{ type: sent.slice(0, 70), id: sent }] },
      { projectId: 'p', receivedAt: new Date() },
    );
    if (!result.ok) throw new Error(result.reason);
    return { tenant: result.row.tenant_id, type: result.row.target_types[0] ?? '', id: result.row.target_ids[0] ?? '' };
  };
  const valid = (tenantId: string, type = 't', id = 'i') => readScopeSchema.safeParse({ tenantId, target: { type, id } }).success;
  const pair = '\u{1F600}';
  for (const sent of [
    'a'.repeat(300), // capped to 256 → longer than any scope id
    `${'a'.repeat(255)}${pair}`, // cap avoids splitting the pair
    'biz\uD800', // lone surrogate → U+FFFD, which scope ids refuse
    '\uDC00biz',
    `${'b'.repeat(249)}\uD800`,
  ]) {
    const s = stored(sent);
    expect(s.tenant).not.toBe(sent);
    expect(valid(s.tenant), JSON.stringify(sent)).toBe(false);
    expect(valid('x', 't', s.id), JSON.stringify(sent)).toBe(false);
  }
  // The documented case: whitespace is trimmed, and the trimmed id is what a scope names.
  for (const sent of [' biz_5', 'biz_5 ', '\tbiz_5\n']) {
    expect(stored(sent).tenant).toBe('biz_5');
    expect(valid(sent)).toBe(false);
    expect(valid('biz_5')).toBe(true);
  }
});

it('builds a parameterized column predicate with a same-position target match', () => {
  expect(scopePredicate(null)).toEqual({ sql: '1', params: {} });
  const p = scopePredicate({ tenantId: "t1' OR 1=1", target: { type: 'website', id: 's1' }, actionPrefixes: ['booking.', 'auth.'] });
  expect(p.sql).toBe(
    [
      'tenant_id = {scope_tenant:String}',
      '(has(target_ids, {scope_target_id:String}) AND arrayExists((t, i) -> t = {scope_target_type:String} AND i = {scope_target_id:String}, target_types, target_ids))',
      '(startsWith(action, {scope_action_0:String}) OR startsWith(action, {scope_action_1:String}))',
    ].join(' AND '),
  );
  // The same paired-target definition as the `record:` query field (#182), so the two cannot drift.
  expect(p.sql).toContain(`(${pairedTargetSql('scope_target_type', 'scope_target_id')})`);
  expect(recordTargetPredicate('website', 's1', 0).sql).toBe(pairedTargetSql('recordType0', 'recordId0'));
  // The predicate never reads the payload (cost: an indexed column check only, #180 benchmark).
  expect(p.sql).not.toContain('payload');
  // Values never reach the SQL text.
  expect(p.sql).not.toContain("t1'");
  expect(p.params).toEqual({
    scope_tenant: "t1' OR 1=1",
    scope_target_type: 'website',
    scope_target_id: 's1',
    scope_action_0: 'booking.',
    scope_action_1: 'auth.',
  });
  expect(() => scopePredicate({ tenantId: '' })).toThrow();
});

it('fingerprints scopes per project, independent of list order and distinct across scopes', () => {
  expect(scopeFingerprint(null, 'p1')).toBeNull();
  const a = scopeFingerprint({ tenantId: 't1', actionPrefixes: ['a.', 'b.'], mask: ['ip', 'user_agent'] }, 'p1');
  expect(a).toBe(scopeFingerprint({ tenantId: 't1', actionPrefixes: ['b.', 'a.'], mask: ['user_agent', 'ip'] }, 'p1'));
  expect(a).not.toBe(scopeFingerprint({ tenantId: 't1', actionPrefixes: ['a.', 'b.'], mask: ['ip', 'user_agent'] }, 'p2'));
  expect(a).not.toBe(scopeFingerprint({ tenantId: 't1', actionPrefixes: ['a.'] }, 'p1'));
  expect(scopeFingerprint({ tenantId: 't1' }, 'p1')).not.toBe(scopeFingerprint({ tenantId: 't1', target: { type: 'w', id: 's' } }, 'p1'));
});
