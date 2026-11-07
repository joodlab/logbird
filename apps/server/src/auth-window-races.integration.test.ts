import { randomUUID } from 'node:crypto';
import { auditNamespace, type Prisma, prisma } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import {
  AUTH_AUDIT_GLOBAL_LIMIT,
  authEmailHash,
  closeLegacyAuthWindows,
  flushAuthAuditBudgets,
  flushFailedSignIns,
  stageFailedSignIn,
} from './auth-failures';
import { env } from './env';
import { sweepAuditRetention } from './outbox-delivery';

it.each([false, true])('keeps the occurrence hour when a fast closer precedes a slow stager (overflow=%s)', async (overflow) => {
  const ns = auditNamespace(),
    userId = randomUUID(),
    org = `qa-skew-${userId}`,
    email = `qa-skew-${userId}@example.test`;
  const hash = authEmailHash(email, env.BETTER_AUTH_SECRET);
  const before = new Date('2053-01-01T12:59:59Z'),
    end = new Date('2053-01-01T13:00:00Z'),
    after = new Date(+end + 1000);
  const budget = `${ns}:ws:${org}:${+end - 3_600_000}`;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(before);
  try {
    await prisma.user.create({ data: { id: userId, name: 'QA Clock Skew', email, emailHash: hash } });
    await prisma.organization.create({
      data: {
        id: org,
        name: 'QA Clock Skew',
        slug: org,
        createdAt: before,
        members: { create: { id: randomUUID(), userId, role: 'member', createdAt: before } },
      },
    });
    await prisma.authAuditBudget.create({ data: { id: budget, namespace: ns, stream: `ws:${org}`, windowEnd: end, admitted: 60 } });
    if (overflow)
      await prisma.authAuditBudget.create({
        data: { id: `${ns}:global:${+end / 3_600_000 - 1}`, namespace: ns, windowEnd: end, admitted: AUTH_AUDIT_GLOBAL_LIMIT },
      });
    for (let i = 0; i < 2; i++) await stageFailedSignIn(email, 'locked_out', { ip: '192.0.2.81' }, env.BETTER_AUTH_SECRET, before);
    const old = await prisma.authAuditWindow.findFirstOrThrow({ where: { namespace: ns, emailHash: hash } });
    await flushFailedSignIns(before, [old.id]);
    vi.setSystemTime(after);
    await flushFailedSignIns(after, [old.id]);
    await flushAuthAuditBudgets(after, [budget]);
    // The closer has committed in the next hour, but this replica's frozen attempt is still in the old one.
    vi.setSystemTime(before);
    await stageFailedSignIn(email, 'locked_out', { ip: '192.0.2.82' }, env.BETTER_AUTH_SECRET, before);
    const next = await prisma.authAuditWindow.findFirstOrThrow({ where: { namespace: ns, emailHash: hash, closedAt: null } });
    expect(next).toMatchObject({ generation: 1, windowEnd: end, firstAttemptAt: before, lastAttemptAt: before, overflow });
    expect(next.id).not.toBe(old.id);
    vi.setSystemTime(after);
    await flushFailedSignIns(after, [next.id]);
    await flushFailedSignIns(after, [next.id]);
    await flushAuthAuditBudgets(after, [budget]);
    await flushAuthAuditBudgets(new Date(+after + 60_000), [budget]);
    const windows = await prisma.authAuditWindow.findMany({ where: { namespace: ns, emailHash: hash } });
    expect(windows).toHaveLength(2);
    expect(windows.every((w) => w.closedAt && !w.quarantinedAt && w.prepareAttempts === 0 && w.attempts === w.flushedAttempts)).toBe(true);
    const rows = await prisma.auditOutbox.findMany({ where: { stream: `ws:${org}` }, orderBy: { id: 'asc' } });
    expect(rows.map((r) => (r.payload as { metadata: { attempts: number } }).metadata.attempts)).toEqual([2, 1]);
    expect(rows.map((r) => (r.payload as { metadata: { targets: unknown } }).metadata.targets)).toEqual([
      [{ userId, attempts: 2 }],
      [{ userId, attempts: 1 }],
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(await prisma.authAuditBudget.findUniqueOrThrow({ where: { id: budget } })).toMatchObject({
      suppressed: 3,
      reportedSuppressed: 3,
      generation: 2,
    });
    expect(await prisma.authAuditBudget.count({ where: { namespace: ns, stream: `ws:${org}`, windowEnd: new Date(+end + 3_600_000) } })).toBe(0);
  } finally {
    vi.useRealTimers();
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
    await prisma.authAuditWindow.deleteMany({ where: { namespace: ns, emailHash: hash } });
    await prisma.authAuditBudget.deleteMany({ where: { namespace: ns } });
    await prisma.organization.deleteMany({ where: { id: org } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

it('rotates more than 100 deferred budgets and reports past a quarantined window', async () => {
  const ns = auditNamespace(),
    prefix = `qa-rotation-${randomUUID()}`;
  const end = new Date('2054-01-01T13:00:00Z'),
    now = new Date(+end + 1000),
    previous = new Date(+end - 3_600_000);
  const deferredIds = Array.from({ length: 100 }, (_, i) => `${prefix}:a:${String(i).padStart(3, '0')}`);
  const ready = `${prefix}:z-ready`,
    stream = `ws:${prefix}`;
  try {
    await prisma.authAuditWindow.createMany({
      data: [
        { id: `${prefix}:open`, namespace: ns, reason: 'invalid_otp', context: {}, windowEnd: end, nextAttemptAt: end },
        {
          id: `${prefix}:poison`,
          namespace: ns,
          reason: 'invalid_otp',
          context: {},
          windowEnd: previous,
          nextAttemptAt: previous,
          quarantinedAt: previous,
          prepareAttempts: 5,
        },
      ],
    });
    await prisma.authAuditBudget.createMany({
      data: [
        ...deferredIds.map((id) => ({ id, namespace: ns, stream, windowEnd: end, suppressed: 1, nextAttemptAt: previous })),
        { id: ready, namespace: ns, stream, windowEnd: previous, suppressed: 2, nextAttemptAt: previous },
      ],
    });
    await flushAuthAuditBudgets(now);
    expect(await prisma.authAuditBudget.count({ where: { id: { in: deferredIds }, nextAttemptAt: { gt: now }, reported: false } })).toBe(100);
    await flushAuthAuditBudgets(now);
    expect(await prisma.authAuditBudget.findUniqueOrThrow({ where: { id: ready } })).toMatchObject({ reported: true, reportedSuppressed: 2 });
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: `auth-suppression-${ready}-1` } })).payload).toMatchObject({
      metadata: { attempts: 2 },
    });
    // A stale healthy-looking window must not wait forever either; recovery will create a later delta.
    await flushAuthAuditBudgets(new Date(+now + 60_001));
    expect(await prisma.authAuditBudget.count({ where: { id: { in: deferredIds }, reported: true } })).toBe(100);
  } finally {
    await prisma.auditOutbox.deleteMany({ where: { stream } });
    await prisma.authAuditBudget.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.authAuditWindow.deleteMany({ where: { id: { startsWith: prefix } } });
  }
});

it('stages member and unknown identities without account or membership lookups', async () => {
  const id = randomUUID(),
    email = `qa-private-${id}@example.test`,
    unknown = `qa-unknown-${id}@example.test`;
  await prisma.user.create({ data: { id, name: 'QA Private Admission', email, emailHash: authEmailHash(email, env.BETTER_AUTH_SECRET) } });
  const userQuery = vi.spyOn(prisma.user, 'findUnique'),
    userHashQuery = vi.spyOn(prisma.user, 'findFirst'),
    memberships = vi.spyOn(prisma.member, 'findMany');
  try {
    await stageFailedSignIn(email, 'invalid_otp', {}, env.BETTER_AUTH_SECRET);
    await stageFailedSignIn(unknown, 'invalid_otp', {}, env.BETTER_AUTH_SECRET);
    expect(userQuery).not.toHaveBeenCalled();
    expect(userHashQuery).not.toHaveBeenCalled();
    expect(memberships).not.toHaveBeenCalled();
    const windows = await prisma.authAuditWindow.findMany({
      where: {
        emailHash: { in: [authEmailHash(email, env.BETTER_AUTH_SECRET), authEmailHash(unknown, env.BETTER_AUTH_SECRET)] },
        namespace: auditNamespace(),
      },
    });
    expect(windows).toHaveLength(2);
    expect(JSON.stringify(windows)).not.toContain('@example.test');
  } finally {
    userQuery.mockRestore();
    userHashQuery.mockRestore();
    memberships.mockRestore();
    await prisma.authAuditWindow.deleteMany({
      where: {
        emailHash: { in: [authEmailHash(email, env.BETTER_AUTH_SECRET), authEmailHash(unknown, env.BETTER_AUTH_SECRET)] },
        namespace: auditNamespace(),
      },
    });
    await prisma.user.delete({ where: { id } });
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const control = vi.hoisted(() => ({
  summary: undefined as undefined | ((tx: Prisma.TransactionClient | undefined) => Promise<void>),
  budget: undefined as undefined | ((id: string) => Promise<void>),
}));
vi.mock('@logbird/database', async (original) => {
  const actual = await original<typeof import('@logbird/database')>();
  return {
    ...actual,
    storeAuditEvent: async (...args: Parameters<typeof actual.storeAuditEvent>) => {
      if (String(args[1].id).includes('-summary-')) await control.summary?.(args[2]);
      if (args[1].action === 'auth.sign_in.suppressed') await control.budget?.(String(args[1].id));
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
    let closingPid = 0;
    control.summary = async (tx) => {
      if (!tx) throw new Error('Missing test transaction');
      closingPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() pid`)[0]?.pid ?? 0;
      entered.resolve();
      await release.promise;
    };
    closing = flushFailedSignIns(boundary, [old.id]);
    await entered.promise; // Actual summary transaction holds the row lock, prior to setting closedAt.
    staging = stageFailedSignIn(email, 'invalid_otp', { requestId: 'late-request', ip: '203.0.113.51' }, env.BETTER_AUTH_SECRET, before);
    await vi.waitFor(async () => {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM pg_stat_activity
        WHERE ${closingPid}=ANY(pg_blocking_pids(pid))`;
      expect(Number(rows[0]?.n)).toBeGreaterThan(0);
    });
    vi.setSystemTime(after);
    release.resolve();
    await closing;
    await staging;
    control.summary = undefined;
    const windows = await prisma.authAuditWindow.findMany({ where: { namespace: ns, emailHash: hash }, orderBy: { generation: 'asc' } });
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ id: old.id, attempts: 2, flushedAttempts: 2 });
    expect(windows[0]?.closedAt).not.toBeNull();
    const next = windows[1];
    if (!next) throw new Error('Next window missing');
    expect(next).toMatchObject({
      attempts: 1,
      flushedAttempts: 0,
      firstAttemptAt: before,
      lastAttemptAt: before,
      windowEnd: old.windowEnd,
      generation: 1,
      closedAt: null,
      overflow,
    });
    await flushFailedSignIns(after, [next.id]);
    await flushFailedSignIns(new Date(+next.windowEnd + 1000), [next.id]);
    const events = await prisma.auditOutbox.findMany({ where: { namespace: ns, stream: `ws:${org}` } });
    expect(events.reduce((sum, row) => sum + Number((row.payload as { metadata: { attempts: number } }).metadata.attempts), 0)).toBe(3);
    expect(new Set(events.map((row) => row.id)).size).toBe(events.length);
    const late = events.find((row) => (row.payload as { context?: { requestId: string } }).context?.requestId === 'late-request');
    expect(late?.payload).toMatchObject({
      occurredAt: before.toISOString(),
      metadata: { firstAttemptAt: before.toISOString(), lastAttemptAt: before.toISOString() },
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

it('fences finalization while a fresh window is uncommitted after INSERT, then reports every suppressed count once', async () => {
  const ns = auditNamespace(),
    userId = randomUUID(),
    org = `qa-admission-${userId}`,
    email = `qa-admission-${userId}@example.test`;
  const hash = authEmailHash(email, env.BETTER_AUTH_SECRET),
    before = new Date('2051-01-01T00:59:59Z'),
    end = new Date('2051-01-01T01:00:00Z');
  const budget = `${ns}:ws:${org}:${+end - 3_600_000}`,
    globalBudgetId = `${ns}:global:${Math.floor(+before / 3_600_000)}`;
  const locked = deferred(),
    release = deferred();
  let holder: Promise<void> | undefined,
    staging: Promise<void> | undefined,
    reporting: Promise<void> | undefined,
    holderPid = 0,
    stagingPid = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(before);
  try {
    await prisma.user.create({ data: { id: userId, name: 'QA Fresh Admission', email, emailHash: hash } });
    await prisma.organization.create({
      data: {
        id: org,
        name: 'QA Fresh Admission',
        slug: org,
        createdAt: before,
        members: { create: { id: randomUUID(), userId, role: 'member', createdAt: before } },
      },
    });
    await prisma.authAuditBudget.createMany({
      data: [
        { id: budget, namespace: ns, stream: `ws:${org}`, windowEnd: end, admitted: 60, suppressed: 5, targets: { [userId]: 5 } },
        { id: globalBudgetId, namespace: ns, windowEnd: end },
      ],
    });
    holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "AuthAuditBudget" WHERE id=${globalBudgetId} FOR UPDATE`;
      holderPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() pid`)[0]?.pid ?? 0;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    staging = stageFailedSignIn(email, 'invalid_otp', { requestId: 'fresh-before-boundary', ip: '192.0.2.72' }, env.BETTER_AUTH_SECRET, before);
    await vi.waitFor(async () => {
      const rows = await prisma.$queryRaw<{ pid: number }[]>`SELECT pid FROM pg_stat_activity WHERE ${holderPid}=ANY(pg_blocking_pids(pid))`;
      stagingPid = rows[0]?.pid ?? 0;
      expect(stagingPid).toBeGreaterThan(0);
    });
    expect(await prisma.authAuditWindow.count({ where: { namespace: ns, emailHash: hash } })).toBe(0); // Its INSERT is still invisible.
    vi.setSystemTime(new Date(+end + 1000));
    reporting = flushAuthAuditBudgets(new Date(), [budget]);
    await vi.waitFor(async () => {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM pg_stat_activity WHERE ${stagingPid}=ANY(pg_blocking_pids(pid))`;
      expect(Number(rows[0]?.n)).toBeGreaterThan(0); // Finalizer waits on the admission's shared namespace/hour fence.
    });
    release.resolve();
    await holder;
    await staging;
    await reporting;
    expect(await prisma.auditOutbox.count({ where: { stream: `ws:${org}` } })).toBe(0);
    expect((await prisma.authAuditBudget.findUniqueOrThrow({ where: { id: budget } })).reported).toBe(false);
    const window = await prisma.authAuditWindow.findFirstOrThrow({ where: { namespace: ns, emailHash: hash } });
    await flushFailedSignIns(new Date(), [window.id]);
    await flushFailedSignIns(new Date(), [window.id]);
    await flushAuthAuditBudgets(new Date(+end + 61_001), [budget]);
    await flushAuthAuditBudgets(new Date(+end + 61_001), [budget]);
    const rows = await prisma.auditOutbox.findMany({ where: { stream: `ws:${org}` } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      action: 'auth.sign_in.suppressed',
      metadata: { attempts: 6, generation: 1, targets: [{ userId, attempts: 6 }] },
    });
    expect((await prisma.authAuditBudget.findUniqueOrThrow({ where: { id: budget } })).reportedSuppressed).toBe(6);
  } finally {
    release.resolve();
    await Promise.allSettled([holder, staging, reporting]);
    vi.useRealTimers();
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
    await prisma.authAuditWindow.deleteMany({ where: { namespace: ns, emailHash: hash } });
    await prisma.authAuditBudget.deleteMany({ where: { id: { in: [budget, globalBudgetId] } } });
    await prisma.organization.deleteMany({ where: { id: org } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

it('reports only reopened-budget deltas and isolates, backs off and quarantines a poison budget', async () => {
  const ns = auditNamespace(),
    userId = randomUUID(),
    org = `qa-budget-delta-${userId}`,
    email = `qa-budget-delta-${userId}@example.test`;
  const hash = authEmailHash(email, env.BETTER_AUTH_SECRET),
    before = new Date('2052-01-01T00:59:59Z'),
    end = new Date('2052-01-01T01:00:00Z');
  const main = `${ns}:ws:${org}:${+end - 3_600_000}`,
    poison = `${ns}:000-poison`,
    healthy = `${ns}:zzz-healthy`;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(before);
  try {
    await prisma.user.create({ data: { id: userId, name: 'QA Budget Delta', email, emailHash: hash } });
    await prisma.organization.create({
      data: {
        id: org,
        name: 'QA Budget Delta',
        slug: org,
        createdAt: before,
        members: { create: { id: randomUUID(), userId, role: 'member', createdAt: before } },
      },
    });
    await prisma.authAuditBudget.create({
      data: { id: main, namespace: ns, stream: `ws:${org}`, windowEnd: end, admitted: 60, suppressed: 5, targets: { [userId]: 5 } },
    });
    await flushAuthAuditBudgets(end, [main]); // Another replica's fast clock finalizes first.
    await stageFailedSignIn(email, 'invalid_otp', { ip: '192.0.2.73' }, env.BETTER_AUTH_SECRET, before);
    vi.setSystemTime(new Date(+end + 1000));
    const window = await prisma.authAuditWindow.findFirstOrThrow({ where: { namespace: ns, emailHash: hash } });
    await flushFailedSignIns(new Date(), [window.id]);
    await flushFailedSignIns(new Date(), [window.id]);
    await prisma.authAuditBudget.createMany({
      data: [
        { id: poison, namespace: ns, stream: `ws:${org}`, windowEnd: end, suppressed: 1 },
        { id: healthy, namespace: ns, stream: `ws:${org}`, windowEnd: end, suppressed: 2 },
      ],
    });
    control.budget = async (id) => {
      if (id.startsWith(`auth-suppression-${poison}-`)) throw new Error('secret injected poison details');
    };
    for (let n = 0; n < 5; n++) await flushAuthAuditBudgets(new Date(+end + 1000 + n * 7_200_000), [poison, main, healthy]);
    const rows = await prisma.auditOutbox.findMany({ where: { stream: `ws:${org}` } });
    const deltas = rows.filter((row) => row.id.startsWith(`auth-suppression-${main}-`)).sort((a, b) => a.id.localeCompare(b.id));
    expect(deltas.map((row) => (row.payload as { metadata: { attempts: number } }).metadata.attempts)).toEqual([5, 1]);
    expect(deltas[1]?.payload).toMatchObject({ metadata: { generation: 2, totalAttempts: 6, targets: [{ userId, attempts: 1 }] } });
    expect(rows.find((row) => row.id === `auth-suppression-${healthy}-1`)?.payload).toMatchObject({ metadata: { attempts: 2 } });
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(await prisma.authAuditBudget.findUniqueOrThrow({ where: { id: poison } })).toMatchObject({
      prepareAttempts: 5,
      lastError: 'audit_budget_preparation_unavailable',
      reported: false,
    });
    expect((await prisma.authAuditBudget.findUniqueOrThrow({ where: { id: poison } })).quarantinedAt).not.toBeNull();
    expect(warn.mock.calls.flat().join(' ')).toContain('audit.preparation_failed');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret injected poison details');
    await sweepAuditRetention(new Date(+end + 3 * 86_400_000));
    expect(await prisma.authAuditBudget.findUnique({ where: { id: poison } })).not.toBeNull();
  } finally {
    control.budget = undefined;
    warn.mockRestore();
    vi.useRealTimers();
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
    await prisma.authAuditWindow.deleteMany({ where: { namespace: ns, emailHash: hash } });
    await prisma.authAuditBudget.deleteMany({ where: { namespace: ns } });
    await prisma.organization.deleteMany({ where: { id: org } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
