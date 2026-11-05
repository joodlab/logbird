import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { keys, meQuery } from '@/lib/api/queries';
import { authCall, authClient } from '@/lib/auth-client';
import { activeRole, isAdminRole } from '@/lib/permissions';

export type Role = 'owner' | 'admin' | 'member';
export const INVITE_ROLES: Role[] = ['member', 'admin'];

export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  owner: { label: 'Owner', description: 'Everything, including other owners and deleting the workspace.' },
  admin: { label: 'Admin', description: 'Projects, API keys, retention and members.' },
  member: { label: 'Member', description: 'Explore events, follow entities, save views.' },
};

export const roleLabel = (role: string) => ROLE_INFO[role as Role]?.label ?? role;

export interface OrgMember {
  id: string;
  userId: string;
  role: string;
  createdAt: string | Date;
  user: { id: string; name: string; email: string; image?: string | null };
}
export interface OrgInvitation {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string | Date;
  createdAt?: string | Date;
}
export interface FullOrganization {
  id: string;
  name: string;
  members: OrgMember[];
  invitations: OrgInvitation[];
}

/** Active workspace with members and invitations (better-auth organization plugin). */
export const organizationQuery = (organizationId: string | null | undefined) =>
  queryOptions({
    queryKey: [...keys.organization, organizationId ?? 'none'] as const,
    queryFn: async () => (await authCall(authClient.organization.getFullOrganization())) as unknown as FullOrganization,
    enabled: Boolean(organizationId),
    staleTime: 15_000,
  });

/** Personal accept link of an email invitation (only the invited address can use it). */
export const invitationUrl = (invitationId: string) =>
  `${typeof window === 'undefined' ? '' : window.location.origin}/accept-invitation/${invitationId}`;

export const isPendingInvitation = (i: OrgInvitation, now = Date.now()) => i.status === 'pending' && new Date(i.expiresAt).getTime() > now;

/** The active workspace, my membership and what I may do in it. */
export function useOrganization() {
  const me = useQuery(meQuery());
  const org = useQuery(organizationQuery(me.data?.activeOrganizationId));
  const self = org.data?.members.find((m) => m.userId === me.data?.user.id);
  const myRole = (self?.role ?? 'member') as Role;
  const owners = org.data?.members.filter((m) => m.role === 'owner').length ?? 0;
  return {
    me,
    org,
    self,
    myRole,
    owners,
    // /api/me is loaded before any workspace page, so this is right even before the member list arrives.
    canManage: isAdminRole(self?.role ?? activeRole(me.data)),
    pending: (org.data?.invitations ?? []).filter((i) => isPendingInvitation(i)),
  };
}

function useRefreshOrganization() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.organization }),
      // Team facts feed the "teammate" setup step of every project.
      queryClient.invalidateQueries({ queryKey: keys.projects }),
      queryClient.invalidateQueries({ queryKey: keys.workspaceSetup }),
    ]);
}

export function useInviteMember() {
  const refresh = useRefreshOrganization();
  return useMutation({
    mutationFn: (value: { email: string; role: Role; resend?: boolean }) =>
      authCall(authClient.organization.inviteMember({ email: value.email.trim().toLowerCase(), role: value.role, resend: value.resend })),
    onSuccess: (invitation, value) => {
      refresh();
      const id = (invitation as { id?: string } | null)?.id;
      toast.success(value.resend ? 'Invitation re-sent' : 'Invitation sent', {
        description: `${value.email} gets an email with a link to join. It is valid for 48 hours.`,
        // The personal link works only for that address: handy when the email lands in spam.
        action: id
          ? {
              label: 'Copy link',
              onClick: () => {
                navigator.clipboard
                  ?.writeText(invitationUrl(id))
                  .then(() => toast.success('Invitation link copied'))
                  .catch(() => undefined);
              },
            }
          : undefined,
      });
    },
  });
}

export function useMemberActions() {
  const refresh = useRefreshOrganization();
  const cancel = useMutation({
    mutationFn: (invitationId: string) => authCall(authClient.organization.cancelInvitation({ invitationId })),
    onSuccess: () => {
      refresh();
      toast.success('Invitation canceled', { description: 'The link in the email no longer works.' });
    },
    onError: (e) => toast.error('Could not cancel the invitation', { description: e.message }),
  });
  const remove = useMutation({
    mutationFn: (member: OrgMember) => authCall(authClient.organization.removeMember({ memberIdOrEmail: member.id })),
    onSuccess: (_, member) => {
      refresh();
      toast.success(`${member.user.name || member.user.email} removed`);
    },
    onError: (e) => toast.error('Could not remove the member', { description: e.message }),
  });
  const changeRole = useMutation({
    mutationFn: (v: { member: OrgMember; role: Role }) => authCall(authClient.organization.updateMemberRole({ memberId: v.member.id, role: v.role })),
    onSuccess: (_, v) => {
      refresh();
      toast.success(
        `${v.member.user.name || v.member.user.email} is now ${roleLabel(v.role).toLowerCase() === 'admin' ? 'an' : 'a'} ${roleLabel(v.role).toLowerCase()}`,
      );
    },
    onError: (e) => toast.error('Could not change the role', { description: e.message }),
  });
  return { cancel, remove, changeRole };
}
