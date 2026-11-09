import { randomUUID } from 'node:crypto';
import { prisma } from '@logbird/database';
import { afterAll, expect, it } from 'vitest';

// The policy is read at module load, so set it before the app is imported.
process.env.AUTH_SIGNUP = 'restricted';
process.env.AUTH_SIGNUP_DOMAINS = 'approved.logbird.test';
const { app } = await import('./app');

const run = randomUUID().slice(0, 8);
const outsider = (label: string) => `${label}-${run}@outsider.logbird.test`;
const userIds: string[] = [];
const orgIds: string[] = [];

const sendCode = (email: string) =>
  app.request('/api/auth/email-otp/send-verification-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
    body: JSON.stringify({ email, type: 'sign-in' }),
  });

afterAll(async () => {
  await prisma.verification.deleteMany({ where: { identifier: { contains: `-${run}@` } } });
  await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  const created = await prisma.user.findMany({ where: { email: { endsWith: `-${run}@approved.logbird.test` } }, select: { id: true } });
  await prisma.user.deleteMany({ where: { id: { in: [...userIds, ...created.map((u) => u.id)] } } });
});

it('real services: restricted signup refuses strangers before a code exists and admits domains, accounts and invitees', async () => {
  // A stranger is refused with a clear 403 and nothing is stored for them.
  const stranger = outsider('stranger');
  const refused = await sendCode(stranger);
  expect(refused.status).toBe(403);
  expect(JSON.stringify(await refused.json())).toContain('approved email domains or by invitation');
  expect(await prisma.verification.count({ where: { identifier: { contains: stranger } } })).toBe(0);
  expect(await prisma.user.count({ where: { email: stranger } })).toBe(0);
  // Verifying a guessed code cannot create the account either.
  const forced = await app.request('/api/auth/sign-in/email-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
    body: JSON.stringify({ email: stranger, otp: '123456' }),
  });
  expect(forced.status).toBe(403);
  expect(await prisma.user.count({ where: { email: stranger } })).toBe(0);

  // An approved domain may request a code.
  expect((await sendCode(`new-${run}@approved.logbird.test`)).status).toBe(200);

  // An existing account outside the approved domains keeps signing in.
  const member = outsider('member');
  const memberId = `signup-${run}-member`;
  userIds.push(memberId);
  await prisma.user.create({ data: { id: memberId, name: 'Fictional member', email: member, emailVerified: true } });
  expect((await sendCode(member)).status).toBe(200);

  // A pending, unexpired email invitation admits a new address; an expired one does not.
  const orgId = `signup-${run}-org`;
  orgIds.push(orgId);
  await prisma.organization.create({ data: { id: orgId, name: 'Fictional signup org', slug: `signup-${run}`, createdAt: new Date() } });
  const invited = outsider('invited');
  const expired = outsider('expired');
  await prisma.invitation.createMany({
    data: [
      { id: `${orgId}-a`, organizationId: orgId, email: invited, inviterId: memberId, expiresAt: new Date(Date.now() + 3_600_000) },
      { id: `${orgId}-b`, organizationId: orgId, email: expired, inviterId: memberId, expiresAt: new Date(Date.now() - 1000) },
    ],
  });
  expect((await sendCode(invited.toUpperCase())).status).toBe(200);
  expect((await sendCode(expired)).status).toBe(403);
});
