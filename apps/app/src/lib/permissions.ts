import { useQuery } from '@tanstack/react-query';
import type { MeResponse } from '@trailmark/contracts';
import { meQuery } from '@/lib/api/queries';

/**
 * Workspace actions the server reserves for owners and admins (apps/server `mutationPermissions`). Members can read
 * everything, save views and delete their own.
 */
export type AdminAction =
  | 'project.create'
  | 'project.update'
  | 'project.delete'
  | 'keys.manage'
  | 'retention.manage'
  | 'setup.manage'
  | 'sampleData.manage'
  | 'testEvent.send'
  | 'members.invite';

const ADMIN_ROLES = ['owner', 'admin'];

/** better-auth stores multiple roles comma-separated ("member,admin"). */
export const isAdminRole = (role: string | null | undefined): boolean => Boolean(role?.split(',').some((r) => ADMIN_ROLES.includes(r.trim())));

/** My role in the active workspace, from `/api/me`. */
export function activeRole(me: MeResponse | undefined): string | null {
  if (!me) return null;
  return me.organizations.find((o) => o.id === me.activeOrganizationId)?.role ?? null;
}

export const canDo = (role: string | null | undefined, _action: AdminAction): boolean => isAdminRole(role);

/** Short label for a control a member cannot use. */
export const ADMINS_ONLY = 'Admins only';
/** Longer explanation (tooltips, notes). */
export const ADMINS_ONLY_HINT = 'Only workspace owners and admins can do this.';

/**
 * What I may do in the active workspace. Reads the cached `/api/me` (every signed-in route loads it first), so it is
 * synchronous in practice; while it is unknown, admin actions read as not allowed.
 */
export function useCan() {
  const me = useQuery(meQuery());
  const role = activeRole(me.data);
  return Object.assign((action: AdminAction) => canDo(role, action), { role, isAdmin: isAdminRole(role), ready: me.isSuccess });
}
