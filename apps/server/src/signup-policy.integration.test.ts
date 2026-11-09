import { randomUUID } from 'node:crypto';
import { prisma } from '@logbird/database';
import { afterAll, expect, it } from 'vitest';

// The policy is read at module load, so set it before the app is imported.
process.env.AUTH_SIGNUP = 'restricted';
process.env.AUTH_SIGNUP_DOMAINS = 'approved.logbird.test';
const { app } = await import('./app');

const run = randomUUID().slice(0, 8);
const outsider = (label: string) => `${label}-${run}@outsider.logbird.test`;
const mailpit = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
const userIds: string[] = [];
const orgIds: string[] = [];

const request = (path: string, body: unknown, cookie = '') =>
  app.request(path, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
    body: JSON.stringify(body),
  });
const sendCode = (email: string) => request('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' });

/** The newest sign-in code Mailpit received for `email`, waiting briefly for background delivery. */
async function codeFor(email: string, waitMs = 3000): Promise<string | undefined> {
  const deadline = Date.now() + waitMs;
  do {
    const box = (await (await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=1`)).json()) as {
      messages: { ID: string }[];
    };
    if (box.messages[0]) {
      const message = (await (await fetch(`${mailpit}/api/v1/message/${box.messages[0].ID}`)).json()) as { Text: string };
      return message.Text.match(/\b\d{6}\b/)?.[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return undefined;
}

afterAll(async () => {
  await prisma.verification.deleteMany({ where: { identifier: { contains: `-${run}@` } } });
  await prisma.inviteLink.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.invitation.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.member.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  const created = await prisma.user.findMany({ where: { email: { contains: `-${run}@` } }, select: { id: true } });
  await prisma.session.deleteMany({ where: { userId: { in: [...userIds, ...created.map((u) => u.id)] } } });
  await prisma.user.deleteMany({ where: { id: { in: [...userIds, ...created.map((u) => u.id)] } } });
});

it('real services: restricted signup is indistinguishable from a wrong code and admits only approved people', async () => {
  // A stranger gets the same 200 as everyone else, but no code is delivered and sign-in fails like a wrong code.
  const stranger = outsider('stranger');
  expect((await sendCode(stranger)).status).toBe(200);
  expect(await codeFor(stranger, 1500)).toBeUndefined();
  const forced = await request('/api/auth/sign-in/email-otp', { email: stranger, otp: '123456' });
  expect(forced.status).toBe(400);
  expect(((await forced.json()) as { code?: string }).code).toBe('INVALID_OTP');
  expect(await prisma.user.count({ where: { email: stranger } })).toBe(0);

  // An approved domain receives a code and signs in.
  const approved = `owner-${run}@approved.logbird.test`;
  expect((await sendCode(approved)).status).toBe(200);
  const ownerOtp = await codeFor(approved);
  expect(ownerOtp).toMatch(/^\d{6}$/);
  const owner = await request('/api/auth/sign-in/email-otp', { email: approved, otp: ownerOtp });
  expect(owner.status).toBe(200);
  const ownerCookie = owner.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');

  // The approved owner may create a workspace.
  const org = await request('/api/auth/organization/create', { name: 'Fictional signup org', slug: `signup-${run}` }, ownerCookie);
  expect(org.status).toBe(200);
  const orgId = ((await org.json()) as { id: string }).id;
  orgIds.push(orgId);
  const ownerId = ((await owner.clone().json()) as { user: { id: string } }).user.id;

  // An existing account outside the approved domains keeps signing in, but may not start a workspace.
  const member = outsider('member');
  const memberId = `signup-${run}-member`;
  userIds.push(memberId);
  await prisma.user.create({ data: { id: memberId, name: 'Fictional member', email: member, emailVerified: true } });
  expect((await sendCode(member)).status).toBe(200);
  const memberSignIn = await request('/api/auth/sign-in/email-otp', { email: member, otp: await codeFor(member) });
  expect(memberSignIn.status).toBe(200);
  const memberCookie = memberSignIn.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
  const refusedOrg = await request('/api/auth/organization/create', { name: 'Outsider org', slug: `outsider-${run}` }, memberCookie);
  expect(refusedOrg.status).toBe(403);

  // Pending email invitations admit a new address; expired and cancelled ones do not.
  const invited = outsider('invited');
  const expired = outsider('expired');
  const cancelled = outsider('cancelled');
  await prisma.invitation.createMany({
    data: [
      { id: `${run}-a`, organizationId: orgId, email: invited, inviterId: ownerId, expiresAt: new Date(Date.now() + 3_600_000) },
      { id: `${run}-b`, organizationId: orgId, email: expired, inviterId: ownerId, expiresAt: new Date(Date.now() - 1000) },
      {
        id: `${run}-c`,
        organizationId: orgId,
        email: cancelled,
        inviterId: ownerId,
        status: 'canceled',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    ],
  });
  expect((await sendCode(invited.toUpperCase())).status).toBe(200);
  expect(await codeFor(invited)).toMatch(/^\d{6}$/);
  for (const refused of [expired, cancelled]) {
    expect((await sendCode(refused)).status).toBe(200);
    expect(await codeFor(refused, 1000)).toBeUndefined();
  }

  // An active invite link limited to a domain admits that domain; a revoked one does not.
  await prisma.inviteLink.createMany({
    data: [
      {
        organizationId: orgId,
        token: `link-${run}-a`,
        role: 'member',
        allowedDomain: 'partner-a.logbird.test',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      {
        organizationId: orgId,
        token: `link-${run}-b`,
        role: 'member',
        allowedDomain: 'partner-b.logbird.test',
        expiresAt: new Date(Date.now() + 3_600_000),
        revokedAt: new Date(),
      },
    ],
  });
  const linked = `linked-${run}@partner-a.logbird.test`;
  expect((await sendCode(linked)).status).toBe(200);
  expect(await codeFor(linked)).toMatch(/^\d{6}$/);
  const revokedLink = `linked-${run}@partner-b.logbird.test`;
  expect((await sendCode(revokedLink)).status).toBe(200);
  expect(await codeFor(revokedLink, 1000)).toBeUndefined();
});
