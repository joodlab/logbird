import { randomBytes, randomUUID } from 'node:crypto';
import {
  acceptInviteLinkResponseSchema,
  createInviteLinkSchema,
  inviteLinkListResponseSchema,
  inviteLinkPreviewSchema,
  inviteLinkSchema,
} from '@trailmark/contracts';
import { Prisma, prisma } from '@trailmark/database';
import { Hono } from 'hono';
import { validator } from 'hono-openapi';
import { env } from './env';
import { ApiError } from './errors';
import { audit } from './ingest';
import { inviteLinkState } from './invite-link-state';
import { limitInviteRequests } from './invite-rate-limit';
import { requireSession } from './middlewares';
import { requireRole } from './middlewares/require-role';
import { doc, routeDoc } from './openapi';
import type { AppEnv } from './types';

const include = { createdBy: { select: { id: true, name: true } }, organization: { select: { id: true, name: true } } } as const;
function serialize(link: Prisma.InviteLinkGetPayload<{ include: typeof include }>) {
  return inviteLinkSchema.parse({
    ...link,
    url: `${env.APP_URL}/join/${link.token}`,
    state: inviteLinkState(link),
    expiresAt: link.expiresAt.toISOString(),
    createdAt: link.createdAt.toISOString(),
    revokedAt: link.revokedAt?.toISOString() ?? null,
  });
}
export const inviteLinkRoutes = new Hono<AppEnv>()
  .get('/invite-links/:token', doc('Invite link preview', inviteLinkPreviewSchema, 200, 'none'), limitInviteRequests, async (c) => {
    c.header('Cache-Control', 'no-store');
    const link = await prisma.inviteLink.findUnique({ where: { token: c.req.param('token') }, include });
    if (!link) throw new ApiError(404, 'invite_link_not_found', 'This invite link does not exist.');
    return c.json(
      inviteLinkPreviewSchema.parse({ ...link, state: inviteLinkState(link), expiresAt: link.expiresAt.toISOString(), inviter: link.createdBy }),
    );
  })
  .post('/invite-links/:token/accept', doc('Accept invite link', acceptInviteLinkResponseSchema), limitInviteRequests, requireSession, async (c) => {
    const result = await prisma.$transaction(async (tx) => {
      const found = await tx.inviteLink.findUnique({ where: { token: c.req.param('token') } });
      if (!found) throw new ApiError(404, 'invite_link_not_found', 'This invite link does not exist.');
      // Lock the workspace too: simultaneous accepts by one user through different links must not duplicate membership.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM organization WHERE id = ${found.organizationId} FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "InviteLink" WHERE id = ${found.id} FOR UPDATE`);
      const link = await tx.inviteLink.findUniqueOrThrow({ where: { id: found.id } });
      const state = inviteLinkState(link);
      if (state !== 'active') throw new ApiError(410, 'invite_link_unavailable', 'This invite link is no longer active.', { state });
      if (link.allowedDomain && c.get('user').email.split('@').at(-1)?.toLowerCase() !== link.allowedDomain.toLowerCase())
        throw new ApiError(403, 'domain_not_allowed', 'Your email domain is not allowed.');
      if (await tx.member.findFirst({ where: { organizationId: link.organizationId, userId: c.get('user').id } }))
        throw new ApiError(409, 'already_member', 'You already belong to this workspace.', { organizationId: link.organizationId });
      // Defense in depth if stored data was written outside the validated create endpoint.
      if (link.role !== 'member' && link.role !== 'admin') throw new ApiError(403, 'invalid_role', 'This link cannot grant that role.');
      await tx.member.create({
        data: { id: randomUUID(), organizationId: link.organizationId, userId: c.get('user').id, role: link.role, createdAt: new Date() },
      });
      await tx.inviteLink.update({ where: { id: link.id }, data: { uses: { increment: 1 } } });
      // better-auth stores activeOrganizationId on the session; cookie caching is disabled in our auth config.
      await tx.session.update({ where: { id: c.get('session').id }, data: { activeOrganizationId: link.organizationId } });
      return { organizationId: link.organizationId, role: link.role };
    });
    c.set('activeOrganizationId', result.organizationId);
    await audit(c, 'member.joined_via_link', { type: 'user', id: c.get('user').id });
    return c.json(acceptInviteLinkResponseSchema.parse(result));
  })
  .get('/workspace/invite-links', doc('List invite links', inviteLinkListResponseSchema), requireSession, async (c) => {
    const links = await prisma.inviteLink.findMany({
      where: { organizationId: (await requireRole(c)).organizationId },
      include,
      orderBy: { createdAt: 'desc' },
    });
    return c.json(inviteLinkListResponseSchema.parse({ data: links.map(serialize) }));
  })
  .post(
    '/workspace/invite-links',
    doc('Create invite link', inviteLinkSchema, 201),
    requireSession,
    validator('json', createInviteLinkSchema, (r) => {
      if (!r.success) throw new ApiError(422, 'validation_error', 'Invalid invite link.', r.error);
    }),
    async (c) => {
      const organizationId = (await requireRole(c)).organizationId;
      const { expiresInDays, ...input } = c.req.valid('json');
      const link = await prisma.inviteLink.create({
        data: {
          ...input,
          allowedDomain: input.allowedDomain?.toLowerCase() ?? null,
          organizationId,
          token: randomBytes(32).toString('base64url'),
          expiresAt: new Date(Date.now() + expiresInDays * 86_400_000),
          createdById: c.get('user').id,
        },
        include,
      });
      await audit(c, 'invite_link.created', { type: 'invite_link', id: link.id });
      return c.json(serialize(link), 201);
    },
  )
  .delete(
    '/workspace/invite-links/:linkId',
    routeDoc('Revoke invite link', { responses: { 204: { description: 'Revoked' } } }),
    requireSession,
    async (c) => {
      const organizationId = (await requireRole(c)).organizationId;
      const where = { id: c.req.param('linkId'), organizationId };
      if (!(await prisma.inviteLink.findFirst({ where }))) throw new ApiError(404, 'invite_link_not_found', 'This invite link does not exist.');
      await prisma.inviteLink.updateMany({ where: { ...where, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit(c, 'invite_link.revoked', { type: 'invite_link', id: where.id });
      return c.body(null, 204);
    },
  );
