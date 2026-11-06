import { type InvitationState, invitationPreviewSchema } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { Hono } from 'hono';
import { ApiError } from './errors';
import { limitInviteRequests } from './invite-rate-limit';
import { doc } from './openapi';
import type { AppEnv } from './types';

const KNOWN_STATES = new Set<string>(['pending', 'accepted', 'rejected', 'canceled']);

/** Derive the state the accept page should show; better-auth leaves expired invitations as "pending". */
export function invitationState(status: string, expiresAt: Date, now = new Date()): InvitationState {
  const known = (KNOWN_STATES.has(status) ? status : 'canceled') as InvitationState;
  return known === 'pending' && expiresAt <= now ? 'expired' : known;
}

/**
 * Public (no session): the invitation id is the secret. Mounted before the session-guarded routers so their `*`
 * middleware never runs for it.
 */
export const invitationRoutes = new Hono<AppEnv>().get(
  '/invitations/:invitationId',
  doc('Invitation preview', invitationPreviewSchema, 200, 'none'),
  limitInviteRequests,
  async (c) => {
    c.header('Cache-Control', 'no-store');
    const invitation = await prisma.invitation.findUnique({
      where: { id: c.req.param('invitationId') },
      include: { organization: { select: { id: true, name: true } }, inviter: { select: { name: true, email: true } } },
    });
    if (!invitation) throw new ApiError(404, 'invitation_not_found', 'This invitation does not exist. Ask for a new one.');
    return c.json(
      invitationPreviewSchema.parse({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role ?? 'member',
        state: invitationState(invitation.status, invitation.expiresAt),
        expiresAt: invitation.expiresAt.toISOString(),
        organization: invitation.organization,
        inviter: invitation.inviter ? { name: invitation.inviter.name?.trim() || invitation.inviter.email } : null,
      }),
    );
  },
);
