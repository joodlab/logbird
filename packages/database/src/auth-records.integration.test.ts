import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { AUTH_RECORD_GRACE_MS, prisma, sweepExpiredAuthRecords } from './index';

/**
 * Runs against the real Postgres in DATABASE_URL (shared in development). Every fixture row expires in the year 2000
 * and the sweep runs with its clock in January 2000, so its cutoffs fall before any real row: it can only ever match
 * these fictional rows, never another developer's sessions, codes or invitations. Before sweeping it checks that no
 * other row falls under those cutoffs and stops if one does. Don't run two copies at once: each would sweep the
 * other's expired fixtures and its exact counts would fail (only fictional rows are lost).
 */
const now = Date.parse('2000-01-10T12:00:00Z');
const at = (msFromNow: number) => new Date(now + msFromNow);
const run = randomUUID();
const userId = `qa-129-user-${run}`;
const orgId = `qa-129-org-${run}`;
const identifier = (label: string) => `sign-in-otp-qa-129-${label}-${run}@example.test`;

afterAll(async () => {
  await prisma.verification.deleteMany({ where: { identifier: { contains: run } } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

it('deletes only records past expiry plus grace, and keeps live and recently expired ones', async () => {
  await prisma.user.create({ data: { id: userId, name: 'QA Purge', email: `qa-129-${run}@example.test` } });
  await prisma.organization.create({ data: { id: orgId, name: 'QA Purge', slug: orgId, createdAt: at(-90 * 86_400_000) } });
  const sessions = {
    expiredLongAgo: { expiresAt: at(-AUTH_RECORD_GRACE_MS.session - 60_000) },
    withinGrace: { expiresAt: at(-60_000) },
    live: { expiresAt: at(86_400_000) },
  };
  for (const [label, { expiresAt }] of Object.entries(sessions))
    await prisma.session.create({
      data: { id: `qa-129-session-${label}-${run}`, token: `qa-129-${label}-${run}`, userId, expiresAt, ipAddress: '192.0.2.10', userAgent: 'QA' },
    });
  const codes = {
    expiredLongAgo: at(-AUTH_RECORD_GRACE_MS.verification - 60_000),
    withinGrace: at(-60_000),
    live: at(600_000),
  };
  for (const [label, expiresAt] of Object.entries(codes))
    await prisma.verification.create({ data: { id: `qa-129-code-${label}-${run}`, identifier: identifier(label), value: 'hashed', expiresAt } });
  const invitations = {
    expiredLongAgo: { expiresAt: at(-AUTH_RECORD_GRACE_MS.invitation - 60_000), status: 'pending' },
    acceptedLongAgo: { expiresAt: at(-AUTH_RECORD_GRACE_MS.invitation - 60_000), status: 'accepted' },
    withinGrace: { expiresAt: at(-86_400_000), status: 'pending' },
    live: { expiresAt: at(2 * 86_400_000), status: 'pending' },
  };
  for (const [label, { expiresAt, status }] of Object.entries(invitations))
    await prisma.invitation.create({
      data: {
        id: `qa-129-invite-${label}-${run}`,
        organizationId: orgId,
        email: `qa-129-invitee-${label}-${run}@example.test`,
        role: 'member',
        status,
        expiresAt,
        inviterId: userId,
      },
    });

  // The sweep is global, so refuse to run if anything other than this run's fixtures falls under its cutoffs: a real
  // row expiring before 2000 would be a broken database, and deleting it is not this test's call.
  const before = (ms: number) => ({ lt: new Date(now - ms) });
  const strangers = await Promise.all([
    prisma.session.count({ where: { expiresAt: before(AUTH_RECORD_GRACE_MS.session), NOT: { userId } } }),
    prisma.verification.count({ where: { expiresAt: before(AUTH_RECORD_GRACE_MS.verification), NOT: { identifier: { contains: run } } } }),
    prisma.invitation.count({ where: { expiresAt: before(AUTH_RECORD_GRACE_MS.invitation), NOT: { organizationId: orgId } } }),
  ]);
  if (strangers.some(Boolean)) throw new Error(`refusing to sweep: ${strangers.join('/')} non-fixture rows expired before 2000`);

  const result = await sweepExpiredAuthRecords(now);
  expect(result.limited).toBe(false);
  // Only the fixture rows can match a January-2000 cutoff (see the header), so the counts are exact.
  expect(result.removed).toEqual({ session: 1, verification: 1, invitation: 2 });

  const left = {
    sessions: (await prisma.session.findMany({ where: { userId }, select: { id: true } })).map((row) => row.id).sort(),
    codes: (await prisma.verification.findMany({ where: { identifier: { contains: run } }, select: { id: true } })).map((row) => row.id).sort(),
    invitations: (await prisma.invitation.findMany({ where: { organizationId: orgId }, select: { id: true } })).map((row) => row.id).sort(),
  };
  expect(left).toEqual({
    sessions: [`qa-129-session-live-${run}`, `qa-129-session-withinGrace-${run}`],
    codes: [`qa-129-code-live-${run}`, `qa-129-code-withinGrace-${run}`],
    invitations: [`qa-129-invite-live-${run}`, `qa-129-invite-withinGrace-${run}`],
  });

  // A second run finds nothing more to do.
  expect((await sweepExpiredAuthRecords(now)).removed).toEqual({ session: 0, verification: 0, invitation: 0 });
});
