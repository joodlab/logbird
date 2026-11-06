import type { InviteLinkState } from '@logbird/contracts';

export function inviteLinkState(
  link: { revokedAt: Date | null; expiresAt: Date; maxUses: number | null; uses: number },
  now = new Date(),
): InviteLinkState {
  if (link.revokedAt) return 'revoked';
  if (link.expiresAt <= now) return 'expired';
  if (link.maxUses !== null && link.uses >= link.maxUses) return 'exhausted';
  return 'active';
}
