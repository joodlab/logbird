import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Invitation preview (GET /api/invitations/:invitationId, public)     */
/* ------------------------------------------------------------------ */

/**
 * pending  – can be accepted or declined
 * accepted / rejected / canceled – already used or withdrawn
 * expired  – still "pending" in storage but past expiresAt
 */
export const INVITATION_STATES = ['pending', 'accepted', 'rejected', 'canceled', 'expired'] as const;
export const invitationStateSchema = z.enum(INVITATION_STATES);
export type InvitationState = z.infer<typeof invitationStateSchema>;

/**
 * What the accept page may show before the visitor signs in. The invitation id is an unguessable token sent only to
 * the invited address, so the preview reveals just enough to prefill sign-in and explain the invite: the invited
 * email, workspace name, inviter name and role. Accepting still goes through better-auth (session + matching email).
 */
export const invitationPreviewSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  state: invitationStateSchema,
  expiresAt: z.string(),
  organization: z.object({ id: z.string(), name: z.string() }),
  inviter: z.object({ name: z.string() }).nullable(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;
