import { randomUUID } from 'node:crypto';
import { auditNamespace, prisma } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import { AUTH_AUDIT_GLOBAL_LIMIT, authEmailHash, closeLegacyAuthWindows, flushFailedSignIns, stageFailedSignIn } from './auth-failures';
import { env } from './env';
import { sweepAuditRetention } from './outbox-delivery';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const control = vi.hoisted(() => ({ summary: undefined as undefined | (() => Promise<void>) }));
vi.mock('@logbird/database', async (original) => {
  const actual = await original<typeof import('@logbird/database')>();
  return {
    ...actual,
    storeAuditEvent: async (...args: Parameters<typeof actual.storeAuditEvent>) => {
      if (String(args[1].id).includes('-summary-')) await control.summary?.();
      return actual.storeAuditEvent(...args);
    },
  };
});

it.each([false, true])('routes late increments to a new generation after a real locked summary (overflow=%s)', async (overflow) => {
  const userId = randomUUID(),
    org = `qa-boundary-${userId}`,
    email = `qa-boundary-${userId}@example.test`;
  const hash = authEmailHash(email, env.BETTER_AUTH_SECRET),
    ns = auditNamespace();
  const before = new Date('2047-01-01T00:59:59Z'),
    boundary = new Date('2047-01-01T01:00:00Z'),
    after = new Date(+boundary + 1000);
  const entered = deferred(),
    release = deferred();
  let closing: Promise<void> | undefined, staging: Promise<void> | undefined;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(before);
  try {
    await prisma.user.create({ data: { id: userId, name: 'QA Boundary Member', email, emailHash: hash } });
    await prisma.organization.create({
      data: {
        id: org,
        name: 'QA Boundary',
        slug: org,
        createdAt: before,
        members: { create: { id: randomUUID(), userId, role: 'member', createdAt: before } },
      },
    });
    if (overflow)
      for (const end of [boundary, new Date(+boundary + 3_600_000)])
        await prisma.authAuditBudget.create({
          data: { id: `${ns}:global:${+end / 3_600_000 - 1}`, namespace: ns, windowEnd: end, admitted: AUTH_AUDIT_GLOBAL_LIMIT },
        });
    for (let i = 0; i < 2; i++)
      await stageFailedSignIn(email, 'invalid_otp', { requestId: `before-${i}`, ip: '203.0.113.50' }, env.BETTER_AUTH_SECRET, before);
    const old = await prisma.authAuditWindow.findFirstOrThrow({ where: { namespace: ns, emailHash: hash } });
    await flushFailedSignIns(before, [old.id]);
    control.summary = async () => {
      entered.resolve();
      await release.promise;
    };
    closing = flushFailedSignIns(boundary, [old.id]);
    await entered.promise; // Actual summary transaction holds the row lock, prior to setting closedAt.
    staging = stageFailedSignIn(email, 'invalid_otp', { requestId: 'late-request', ip: '203.0.113.51' }, env.BETTER_AUTH_SECRET, before);
    await vi.waitFor(async () => {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND (query LIKE '%INSERT INTO "AuthAuditWindow"%' OR query LIKE '%SELECT "closedAt" FROM "AuthAuditWindow"%')`;
      expect(Number(rows[0]?.n)).toBeGreaterThan(0);
    });
    vi.setSystemTime(after);
    release.resolve();
    await closing;
    await staging;
    control.summary = undefined;
    const windows = await prisma.authAuditWindow.findMany({ where: { namespace: ns, emailHash: hash }, orderBy: { windowEnd: 'asc' } });
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ id: old.id, attempts: 2, flushedAttempts: 2 });
    expect(windows[0]?.closedAt).not.toBeNull();
    const next = windows[1];
    if (!next) throw new Error('Next window missing');
    expect(next).toMatchObject({ attempts: 1, flushedAttempts: 0, firstAttemptAt: after, lastAttemptAt: after, closedAt: null, overflow });
    await flushFailedSignIns(after, [next.id]);
    await flushFailedSignIns(new Date(+next.windowEnd + 1000), [next.id]);
    const events = await prisma.auditOutbox.findMany({ where: { namespace: ns, stream: `ws:${org}` } });
    expect(events.reduce((sum, row) => sum + Number((row.payload as { metadata: { attempts: number } }).metadata.attempts), 0)).toBe(3);
    expect(new Set(events.map((row) => row.id)).size).toBe(events.length);
    const late = events.find((row) => (row.payload as { context?: { requestId: string } }).context?.requestId === 'late-request');
    expect(late?.payload).toMatchObject({
      occurredAt: after.toISOString(),
      metadata: { firstAttemptAt: after.toISOString(), lastAttemptAt: after.toISOString() },
    });
  } finally {
    release.resolve();
    await Promise.allSettled([closing, staging]);
    control.summary = undefined;
    vi.useRealTimers();
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
    await prisma.authAuditWindow.deleteMany({ where: { namespace: ns, emailHash: hash } });
    await prisma.authAuditBudget.deleteMany({ where: { namespace: ns } });
    await prisma.organization.deleteMany({ where: { id: org } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

it('closes the actual completed round-2 shape without inventing times, prunes it and its budget, retains unresolved legacy data', async () => {
  const ns = auditNamespace(),
    prefix = `qa-legacy-${randomUUID()}`,
    end = new Date('2048-01-01T01:00:00Z'),
    now = new Date('2048-01-03T01:00:00Z');
  try {
    await prisma.authAuditWindow.createMany({
      data: [
        {
          id: `${prefix}-done`,
          namespace: ns,
          identity: '',
          reason: 'invalid_otp',
          context: { requestId: 'round-2' },
          attempts: 4,
          flushedAttempts: 4,
          windowEnd: end,
          nextAttemptAt: new Date('9999-01-01T00:00:00Z'),
        },
        {
          id: `${prefix}-pending`,
          namespace: ns,
          identity: 'retained-encrypted-identity',
          reason: 'invalid_otp',
          context: {},
          attempts: 4,
          flushedAttempts: 1,
          windowEnd: new Date(+end + 3_600_000),
          nextAttemptAt: new Date('9999-01-01T00:00:00Z'),
        },
      ],
    });
    await prisma.authAuditBudget.create({ data: { id: prefix, namespace: ns, windowEnd: end, reported: true } });
    const old = await prisma.authAuditWindow.findUniqueOrThrow({ where: { id: `${prefix}-done` } });
    expect(await closeLegacyAuthWindows(now)).toBe(1);
    const closed = await prisma.authAuditWindow.findUniqueOrThrow({ where: { id: old.id } });
    expect(closed).toMatchObject({ closedAt: now, firstAttemptAt: old.firstAttemptAt, lastAttemptAt: old.lastAttemptAt, context: old.context });
    await sweepAuditRetention(now);
    expect(await prisma.authAuditWindow.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.authAuditBudget.findUnique({ where: { id: prefix } })).toBeNull();
    expect(await prisma.authAuditWindow.findUniqueOrThrow({ where: { id: `${prefix}-pending` } })).toMatchObject({
      closedAt: null,
      identity: 'retained-encrypted-identity',
    });
    expect(await closeLegacyAuthWindows(now)).toBe(0);
  } finally {
    await prisma.authAuditWindow.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.authAuditBudget.deleteMany({ where: { id: prefix } });
  }
});
