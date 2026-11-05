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

/* ------------------------------------------------------------------ */
/* Invite links (shareable join links, no email needed)                */
/* ------------------------------------------------------------------ */

/**
 * A workspace admin creates a link (`${APP_URL}/join/<token>`) that anyone can open to join the active workspace with
 * the link's role, until it expires, runs out of uses, or is revoked. Owners only via email invitations: links grant
 * `member` or `admin`. Optional `allowedDomain` restricts joiners to emails ending in `@<domain>`.
 * Tokens are 32+ random URL-safe chars, stored so admins can copy the link again (list is admin-only).
 */
export const INVITE_LINK_ROLES = ['member', 'admin'] as const;
export const inviteLinkRoleSchema = z.enum(INVITE_LINK_ROLES);
export const INVITE_LINK_EXPIRY_DAYS = [1, 7, 30] as const;

export const INVITE_LINK_STATES = ['active', 'expired', 'revoked', 'exhausted'] as const;
export const inviteLinkStateSchema = z.enum(INVITE_LINK_STATES);
export type InviteLinkState = z.infer<typeof inviteLinkStateSchema>;

export const inviteLinkSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  url: z.string(), // full join URL, `${APP_URL}/join/<token>`
  role: inviteLinkRoleSchema,
  allowedDomain: z.string().nullable(), // e.g. "acme.com"
  maxUses: z.number().int().nullable(), // null = unlimited
  uses: z.number().int(),
  state: inviteLinkStateSchema,
  expiresAt: z.string(),
  createdAt: z.string(),
  createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
  revokedAt: z.string().nullable(),
});
export type InviteLink = z.infer<typeof inviteLinkSchema>;

/** POST /api/workspace/invite-links (owner/admin of the active workspace). */
export const createInviteLinkSchema = z.object({
  role: inviteLinkRoleSchema.default('member'),
  expiresInDays: z
    .number()
    .int()
    .refine((v) => (INVITE_LINK_EXPIRY_DAYS as readonly number[]).includes(v))
    .default(7),
  maxUses: z.number().int().min(1).max(1000).nullable().default(null),
  allowedDomain: z
    .string()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)
    .nullable()
    .default(null),
});
export const inviteLinkListResponseSchema = z.object({ data: z.array(inviteLinkSchema) });

/** GET /api/invite-links/:token (public, signed-out ok): what the join page shows before sign-in. */
export const inviteLinkPreviewSchema = z.object({
  state: inviteLinkStateSchema,
  role: inviteLinkRoleSchema,
  allowedDomain: z.string().nullable(),
  expiresAt: z.string(),
  organization: z.object({ id: z.string(), name: z.string() }),
  inviter: z.object({ name: z.string() }).nullable(),
});
export type InviteLinkPreview = z.infer<typeof inviteLinkPreviewSchema>;

/**
 * POST /api/invite-links/:token/accept (session). Joins the signed-in user to the workspace and sets it active.
 * Errors: 404 unknown, 410 expired/revoked/exhausted, 403 email domain not allowed, 409 already a member (returns the
 * organizationId in details so the UI can just switch to it).
 */
export const acceptInviteLinkResponseSchema = z.object({ organizationId: z.string(), role: inviteLinkRoleSchema });
