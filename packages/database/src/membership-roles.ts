export const workspaceAdminRoles = ['owner', 'admin'] as const;

export function hasWorkspaceRole(role: string, allowed: readonly string[]) {
  return role.split(',').some((value) => allowed.includes(value.trim()));
}

export const hasAdminRole = (role: string) => hasWorkspaceRole(role, workspaceAdminRoles);
