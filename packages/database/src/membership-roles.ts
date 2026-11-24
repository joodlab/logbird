export const workspaceAdminRoles = ['owner', 'admin'] as const;

export function hasWorkspaceRole(role: string, allowed: readonly string[]) {
  return role.split(',').some((value) => allowed.includes(value.trim()));
}

export const hasAdminRole = (role: string) => hasWorkspaceRole(role, workspaceAdminRoles);

/**
 * Raised by the `member_keep_an_owner` trigger (migration 20261124120000_member_keep_an_owner) when a delete or role
 * change would leave an organization without an owner. Its SQL test for "is an owner" (`logbird_is_owner`) is the same
 * as hasWorkspaceRole(role, ['owner']) above; a test checks the two against each other.
 */
export const WORKSPACE_NEEDS_OWNER = {
  code: 'workspace_needs_owner',
  message: 'A workspace needs at least one owner. Make another member an owner first.',
} as const;

/** Whether an error (from Prisma, with any cause chain) is that trigger's refusal. */
export function isWorkspaceNeedsOwnerError(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const e = current as { message?: unknown; code?: unknown; cause?: unknown; meta?: unknown };
    if (e.code === 'LB409' || /logbird_workspace_needs_owner/.test(`${String(e.message ?? '')} ${JSON.stringify(e.meta ?? '')}`)) return true;
    current = e.cause;
  }
  return false;
}
