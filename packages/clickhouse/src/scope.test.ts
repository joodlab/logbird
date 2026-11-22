import { expect, it } from 'vitest';
import { scopeFingerprint, scopePredicate } from './scope';

it('builds a parameterized predicate on columns and on the exact stored payload', () => {
  expect(scopePredicate(null)).toEqual({ sql: '1', params: {} });
  const p = scopePredicate({ tenantId: "t1' OR 1=1", target: { type: 'website', id: 's1' }, actionPrefixes: ['booking.', 'auth.'] });
  expect(p.sql.split(' AND (')[0]).toBe(
    [
      'tenant_id = {scope_tenant:String}',
      "JSONExtractString(payload, 'tenant', 'id') = {scope_tenant:String}",
      'arrayExists((t, i) -> t = {scope_target_type:String} AND i = {scope_target_id:String}, target_types, target_ids)',
      "arrayExists(x -> JSONExtractString(x, 'type') = {scope_target_type:String} AND JSONExtractString(x, 'id') = {scope_target_id:String}, arraySlice(JSONExtractArrayRaw(payload, 'targets'), 1, 64))",
    ].join(' AND '),
  );
  expect(p.sql).toContain('(startsWith(action, {scope_action_0:String}) OR startsWith(action, {scope_action_1:String}))');
  expect(p.sql).toContain(
    "(startsWith(JSONExtractString(payload, 'action'), {scope_action_0:String}) OR startsWith(JSONExtractString(payload, 'action'), {scope_action_1:String}))",
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

it('fingerprints scopes per project, independent of list order and distinct across scopes', () => {
  expect(scopeFingerprint(null, 'p1')).toBeNull();
  const a = scopeFingerprint({ tenantId: 't1', actionPrefixes: ['a.', 'b.'], mask: ['ip', 'user_agent'] }, 'p1');
  expect(a).toBe(scopeFingerprint({ tenantId: 't1', actionPrefixes: ['b.', 'a.'], mask: ['user_agent', 'ip'] }, 'p1'));
  expect(a).not.toBe(scopeFingerprint({ tenantId: 't1', actionPrefixes: ['a.', 'b.'], mask: ['ip', 'user_agent'] }, 'p2'));
  expect(a).not.toBe(scopeFingerprint({ tenantId: 't1', actionPrefixes: ['a.'] }, 'p1'));
  expect(scopeFingerprint({ tenantId: 't1' }, 'p1')).not.toBe(scopeFingerprint({ tenantId: 't1', target: { type: 'w', id: 's' } }, 'p1'));
});
