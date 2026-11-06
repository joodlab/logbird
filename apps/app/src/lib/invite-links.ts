import type { InviteLink, InviteLinkState } from '@logbird/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { inviteLinksQuery, keys } from '@/lib/api/queries';
import { useOrganization } from '@/lib/organization';

export type InviteLinkRole = InviteLink['role'];
export interface CreateInviteLinkInput {
  role: InviteLinkRole;
  expiresInDays: number;
  maxUses: number | null;
  allowedDomain: string | null;
}

/** Invite links of the active workspace. The endpoint is admin-only, so members never request it. */
export function useInviteLinks() {
  const { me, canManage } = useOrganization();
  const organizationId = me.data?.activeOrganizationId;
  return useQuery({ ...inviteLinksQuery(organizationId), enabled: Boolean(organizationId) && canManage });
}

function useRefreshInviteLinks() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: keys.organization });
}

export function useCreateInviteLink() {
  const refresh = useRefreshInviteLinks();
  return useMutation({
    mutationFn: (input: CreateInviteLinkInput) => api.inviteLinks.create(input),
    onSuccess: () => refresh(),
  });
}

export function useRevokeInviteLink() {
  const refresh = useRefreshInviteLinks();
  return useMutation({
    mutationFn: (link: InviteLink) => api.inviteLinks.revoke(link.id),
    onSuccess: () => {
      refresh();
      toast.success('Invite link revoked', { description: 'Anyone opening it now sees that it no longer works.' });
    },
    onError: (error) => toast.error('Could not revoke the link', { description: errorMessage(error) }),
  });
}

export const INVITE_LINK_STATE_LABEL: Record<InviteLinkState, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
  exhausted: 'Used up',
};

/** "3 of 10 uses" / "3 uses" / "Not used yet". */
export function usesLabel(link: Pick<InviteLink, 'uses' | 'maxUses'>): string {
  if (link.maxUses !== null) return `${link.uses} of ${link.maxUses} ${link.maxUses === 1 ? 'use' : 'uses'}`;
  if (link.uses === 0) return 'Not used yet';
  return `${link.uses} ${link.uses === 1 ? 'use' : 'uses'}`;
}

/** Accepts "acme.com", "@acme.com" or a full address and returns the bare domain the contract expects. */
export function normalizeDomain(value: string): string {
  const v = value.trim().toLowerCase();
  return v.includes('@') ? (v.split('@').at(-1) ?? '') : v;
}

export const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

export const emailDomain = (email: string) => email.split('@').at(-1)?.toLowerCase() ?? '';
