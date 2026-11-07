import { createHmac, randomUUID } from 'node:crypto';
import { auditNamespace, prisma } from '@logbird/database';
import { expect, it } from 'vitest';
import { app } from './app';
import { env } from './env';

it('real revoke-session, revoke-other-sessions and revoke-sessions preserve one confirmed intent per deleted session', async () => {
  const userId = randomUUID(),
    org = `qa-revoke-${userId}`;
  const create = () =>
    prisma.session.create({
      data: {
        id: randomUUID(),
        userId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        activeOrganizationId: org,
        ipAddress: '203.0.113.49',
        userAgent: 'QA revoked device',
      },
    });
  try {
    await prisma.user.create({ data: { id: userId, name: 'QA Session Owner', email: `qa-sessions-${userId}@example.test` } });
    await prisma.organization.create({
      data: {
        id: org,
        name: 'QA Revoke',
        slug: org,
        createdAt: new Date(),
        members: { create: { id: randomUUID(), userId, role: 'owner', createdAt: new Date() } },
      },
    });
    const actor = await create(),
      one = await create(),
      two = await create();
    const cookie = `logbird.session_token=${encodeURIComponent(`${actor.token}.${createHmac('sha256', env.BETTER_AUTH_SECRET).update(actor.token).digest('base64')}`)}`;
    const request = (path: string, body: unknown) =>
      app.request(`/api/auth/${path}`, {
        method: 'POST',
        headers: { cookie, Origin: env.APP_URL, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await request('revoke-session', { token: one.token })).status).toBe(200);
    expect(await prisma.session.findUnique({ where: { id: one.id } })).toBeNull();
    expect((await request('revoke-other-sessions', {})).status).toBe(200);
    expect(await prisma.session.findUnique({ where: { id: two.id } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { id: actor.id } })).not.toBeNull();
    const three = await create();
    expect((await request('revoke-sessions', {})).status).toBe(200);
    expect(await prisma.session.count({ where: { userId } })).toBe(0);
    const rows = await prisma.auditOutbox.findMany({ where: { namespace: auditNamespace(), stream: `ws:${org}` } });
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.sourceSessionId).sort()).toEqual([one.id, two.id, actor.id, three.id].sort());
    expect(rows.every((row) => row.confirmedAt !== null && row.deliveredAt === null)).toBe(true);
    for (const row of rows) {
      expect(row.payload).toMatchObject({
        action: 'auth.session.revoked',
        metadata: { session: { ipAddress: '203.0.113.49', userAgent: 'QA revoked device' } },
      });
      expect(JSON.stringify(row.payload)).not.toContain(actor.token);
      expect(JSON.stringify(row.payload)).not.toContain(one.token);
    }
  } finally {
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
    await prisma.organization.deleteMany({ where: { id: org } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
