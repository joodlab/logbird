import { describe, expect, it } from 'vitest';
import { activeRole, canDo, isAdminRole } from './permissions';

describe('isAdminRole', () => {
  it('admits owners and admins, including comma-separated roles', () => {
    expect(isAdminRole('owner')).toBe(true);
    expect(isAdminRole('admin')).toBe(true);
    expect(isAdminRole('member, admin')).toBe(true);
    expect(isAdminRole('member')).toBe(false);
    expect(isAdminRole('')).toBe(false);
    expect(isAdminRole(null)).toBe(false);
  });

  it('gates every admin action for members', () => {
    expect(canDo('member', 'keys.manage')).toBe(false);
    expect(canDo('member', 'project.delete')).toBe(false);
    expect(canDo('admin', 'retention.manage')).toBe(true);
  });
});

describe('activeRole', () => {
  it('reads the role of the active workspace', () => {
    const me = {
      user: { id: 'u', name: 'Max', email: 'max@example.test', image: null },
      organizations: [
        { id: 'a', name: 'A', slug: 'a', role: 'owner' },
        { id: 'b', name: 'B', slug: 'b', role: 'member' },
      ],
      activeOrganizationId: 'b',
    };
    expect(activeRole(me)).toBe('member');
    expect(activeRole({ ...me, activeOrganizationId: null })).toBeNull();
    expect(activeRole(undefined)).toBeNull();
  });
});
