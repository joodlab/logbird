import { expect, it } from 'vitest';
import { scopeFingerprint, scopePredicate } from './scope';

it('builds a parameterized predicate with a same-position target match', () => {
  expect(scopePredicate(null)).toEqual({ sql: '1', params: {} });
  const p = scopePredicate({ tenantId: "t1' OR 1=1", target: { type: 'website', id: 's1' }, actionPrefixes: ['booking.', 'auth.'] });
  expect(p.sql).toBe(
    'tenant_id = {scope_tenant:String} AND arrayExists((t, i) -> t = {scope_target_type:String} AND i = {scope_target_id:String}, target_types, target_ids) AND (startsWith(action, {scope_action_0:String}) OR startsWith(action, {scope_action_1:String}))',
  );
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

it('fingerprints scopes independent of list order and distinct across scopes', () => {
  expect(scopeFingerprint(null)).toBeNull();
  const a = scopeFingerprint({ tenantId: 't1', actionPrefixes: ['a.', 'b.'], mask: ['ip', 'user_agent'] });
  expect(a).toBe(scopeFingerprint({ tenantId: 't1', actionPrefixes: ['b.', 'a.'], mask: ['user_agent', 'ip'] }));
  expect(a).not.toBe(scopeFingerprint({ tenantId: 't1', actionPrefixes: ['a.'] }));
  expect(scopeFingerprint({ tenantId: 't1' })).not.toBe(scopeFingerprint({ tenantId: 't1', target: { type: 'w', id: 's' } }));
});
