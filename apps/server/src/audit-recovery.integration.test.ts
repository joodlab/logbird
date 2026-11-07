import { randomUUID } from 'node:crypto';
import { auditNamespace, prisma, storeAuditEvent } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import { confirmSessionEnd, reconcileSessionAudit, stageSessionEnd } from '../../../packages/auth/src/session-audit';
import { app } from './app';
import { AUTH_AUDIT_GLOBAL_LIMIT, authEmailHash, flushAuthAuditBudgets, flushFailedSignIns, stageFailedSignIn } from './auth-failures';
import { env } from './env';
import { auditDrainStatus, claimAuditEvents, deliverOutboxEvent, startAuditDrainer, sweepAuditRetention } from './outbox-delivery';

it('recovers a session deletion crash, retains aborted intents, and freezes revoked device details', async () => {
  const id = randomUUID(),
    org = `qa-recovery-${id}`,
    token = randomUUID();
  const makeSession = () =>
    prisma.session.create({
      data: {
        id: randomUUID(),
        userId: id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        ipAddress: '203.0.113.10',
        userAgent: 'QA revoked device',
      },
    });
  try {
    await prisma.user.create({ data: { id, name: 'QA Recovery', email: `qa-recovery-${id}@example.test` } });
    await prisma.organization.create({
      data: {
        id: org,
        name: 'QA Recovery',
        slug: org,
        createdAt: new Date(),
        members: { create: { id: randomUUID(), userId: id, role: 'owner', createdAt: new Date() } },
      },
    });
    const deleted = await makeSession(),
      aborted = await makeSession();
    const context = { path: '/api/auth/revoke-other-sessions', requestId: token, ip: '203.0.113.11', userAgent: 'QA requester' };
    await stageSessionEnd(deleted, context);
    await stageSessionEnd(aborted, context);
    expect(await claimAuditEvents()).toHaveLength(0);
    await prisma.session.delete({ where: { id: deleted.id } }); // Simulated process loss: no after-hook.
    await reconcileSessionAudit(new Date(Date.now() + 61_000));
    const rows = await prisma.auditOutbox.findMany({ where: { stream: `ws:${org}` } });
    const recovered = rows.find((row) => row.sourceSessionId === deleted.id);
    if (!recovered) throw new Error('Recovery intent missing');
    expect(recovered.confirmedAt).not.toBeNull();
    expect(recovered.payload).toMatchObject({
      metadata: { session: { ipAddress: '203.0.113.10', userAgent: 'QA revoked device' } },
      context: { ip: '203.0.113.11' },
    });
    const notCommitted = rows.find((row) => row.sourceSessionId === aborted.id);
    if (!notCommitted) throw new Error('Aborted intent missing');
    expect(notCommitted).toMatchObject({ confirmedAt: null, lastError: 'not_committed' });
    expect(notCommitted.quarantinedAt).not.toBeNull();
    await deliverOutboxEvent(recovered.id, async () => ({ accepted: 1, rejected: [] }));
    await confirmSessionEnd(deleted); // Idempotent confirmation cannot rewrite frozen evidence.
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: recovered.id } })).deliveredAt).not.toBeNull();
  } finally {
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
    await prisma.organization.deleteMany({ where: { id: org } });
    await prisma.user.deleteMany({ where: { id } });
  }
});

it('a poison window and a preparation failure cannot stop healthy queued delivery', async () => {
  const id = randomUUID(),
    stream = `ws:qa-poison-${id}`;
  let drainer: ReturnType<typeof startAuditDrainer> | undefined;
  try {
    await prisma.authAuditWindow.create({
      data: {
        id,
        namespace: auditNamespace(),
        identity: 'unreadable-legacy-fixture',
        reason: 'invalid_otp',
        context: {},
        windowEnd: new Date(Date.now() + 300_000),
      },
    });
    await storeAuditEvent(stream, { id: `healthy-${id}`, action: 'project.created' });
    drainer = startAuditDrainer(
      async () => ({ accepted: 1, rejected: [] }),
      async () => {
        await flushFailedSignIns(new Date(), [id]);
        throw new Error('fictional preparation failure');
      },
    );
    await vi.waitFor(async () => expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: `healthy-${id}` } })).deliveredAt).not.toBeNull());
    await drainer.stop();
    const poison = await prisma.authAuditWindow.findUniqueOrThrow({ where: { id } });
    expect(poison).toMatchObject({ lastError: 'legacy_identity_unresolved', identity: 'unreadable-legacy-fixture' });
    expect(poison.quarantinedAt).not.toBeNull();
  } finally {
    await drainer?.stop();
    await prisma.auditOutbox.deleteMany({ where: { stream } });
    await prisma.authAuditWindow.deleteMany({ where: { id } });
  }
});

it('quarantines permanent delivery failures, preserves safe codes, and reports non-failing readiness lag', async () => {
  const id = randomUUID();
  try {
    await storeAuditEvent(`ws:qa-invalid-${id}`, { id, action: 'project.created' });
    const before = (await auditDrainStatus()).undelivered;
    for (let n = 0; n < 10; n++)
      await deliverOutboxEvent(
        id,
        async () => {
          throw Object.assign(new Error('secret must not leak'), { code: 'invalid_event' });
        },
        new Date(Date.now() + n * 7_200_000),
      );
    const row = await prisma.auditOutbox.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ lastError: 'invalid_event', attempts: 10, deliveredAt: null });
    expect(row.quarantinedAt).not.toBeNull();
    expect(await claimAuditEvents(new Date(Date.now() + 100 * 7_200_000), id)).toHaveLength(0);
    expect(await auditDrainStatus()).toMatchObject({ undelivered: before, quarantined: 1 });
    const ready = await app.request('/readyz');
    expect(ready.status).toBe(200);
    expect((await ready.json()).audit.undelivered).toBeGreaterThanOrEqual(1);
    await prisma.auditOutbox.update({ where: { id }, data: { quarantinedAt: null, attempts: 0, nextAttemptAt: new Date() } });
    await deliverOutboxEvent(id, async () => ({ accepted: 0, rejected: [{ reason: 'invalid_event: secret' }] }));
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id } })).lastError).toBe('invalid_event');
    await deliverOutboxEvent(id, async () => ({ accepted: 0, rejected: [{ reason: 'other secret' }] }), new Date(Date.now() + 70_000));
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id } })).lastError).toBe('audit_rejected');
  } finally {
    await prisma.auditOutbox.deleteMany({ where: { id } });
  }
});

it('retains pending, quarantined and late-increment evidence while pruning only expired completed rows', async () => {
  const prefix = `qa-retention-${randomUUID()}`,
    now = new Date('2043-01-10T00:00:00Z'),
    old = new Date('2043-01-01T00:00:00Z'),
    ns = auditNamespace();
  try {
    for (const suffix of ['delivered', 'pending', 'quarantine'])
      await storeAuditEvent(`ws:${prefix}`, { id: `${prefix}-${suffix}`, action: 'project.created' });
    await prisma.auditOutbox.update({ where: { id: `${prefix}-delivered` }, data: { deliveredAt: old } });
    await prisma.auditOutbox.update({ where: { id: `${prefix}-quarantine` }, data: { deliveredAt: old, quarantinedAt: old } });
    for (const suffix of ['closed', 'pending', 'late', 'quarantine'])
      await prisma.authAuditWindow.create({
        data: {
          id: `${prefix}-${suffix}`,
          namespace: ns,
          reason: 'invalid_otp',
          context: {},
          windowEnd: old,
          attempts: 2,
          flushedAttempts: suffix === 'late' ? 1 : 2,
          closedAt: suffix === 'pending' ? null : old,
          quarantinedAt: suffix === 'quarantine' ? old : null,
        },
      });
    await prisma.authAuditBudget.createMany({
      data: [
        { id: `${prefix}-reported`, namespace: ns, windowEnd: old, reported: true },
        { id: `${prefix}-unreported`, namespace: ns, windowEnd: old },
      ],
    });
    await sweepAuditRetention(now);
    expect(await prisma.auditOutbox.count({ where: { stream: `ws:${prefix}` } })).toBe(2);
    expect(await prisma.authAuditWindow.count({ where: { id: { startsWith: prefix } } })).toBe(3);
    expect(await prisma.authAuditBudget.count({ where: { id: { startsWith: prefix } } })).toBe(1);
  } finally {
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${prefix}` } });
    await prisma.authAuditWindow.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.authAuditBudget.deleteMany({ where: { id: { startsWith: prefix } } });
  }
});

it('keeps member evidence above the global cap, freezes first/last times, and never attributes a summary to one request', async () => {
  const id = randomUUID(),
    org = `qa-overflow-${id}`,
    email = `qa-overflow-${id}@example.test`,
    secret = env.BETTER_AUTH_SECRET;
  const now = new Date('2044-01-01T00:00:01Z'),
    globalId = `${auditNamespace()}:global:${Math.floor(+now / 3_600_000)}`,
    hash = authEmailHash(email, secret);
  try {
    await prisma.user.create({ data: { id, name: '', email, emailHash: hash } });
    await prisma.organization.create({
      data: {
        id: org,
        name: 'QA Overflow',
        slug: org,
        createdAt: now,
        members: { create: { id: randomUUID(), userId: id, role: 'member', createdAt: now } },
      },
    });
    await prisma.authAuditBudget.create({
      data: { id: globalId, namespace: auditNamespace(), windowEnd: new Date('2044-01-01T01:00:00Z'), admitted: AUTH_AUDIT_GLOBAL_LIMIT },
    });
    for (let n = 0; n < 12; n++)
      await stageFailedSignIn(
        email,
        'invalid_otp',
        { requestId: `request-${n}`, ip: `203.0.113.${20 + n}`, userAgent: `QA peer ${n}` },
        secret,
        new Date(+now + n * 1000),
      );
    const window = await prisma.authAuditWindow.findFirstOrThrow({ where: { emailHash: hash } });
    expect(window).toMatchObject({ attempts: 12, overflow: true, identity: '' });
    await flushFailedSignIns(new Date('2044-01-01T02:00:00Z'), [window.id]);
    await flushFailedSignIns(new Date('2044-01-01T02:00:01Z'), [window.id]);
    const events = await prisma.auditOutbox.findMany({ where: { stream: `ws:${org}` }, orderBy: { createdAt: 'asc' } });
    expect(events).toHaveLength(2);
    expect(events[0]?.payload).toMatchObject({
      occurredAt: now.toISOString(),
      targets: [{ id, name: email }],
      context: { requestId: 'request-0' },
      metadata: { attempts: 1 },
    });
    expect(events[1]?.payload).toMatchObject({
      occurredAt: new Date(+now + 11_000).toISOString(),
      metadata: {
        attempts: 11,
        distinctIps: [
          '203.0.113.20',
          '203.0.113.21',
          '203.0.113.22',
          '203.0.113.23',
          '203.0.113.24',
          '203.0.113.25',
          '203.0.113.26',
          '203.0.113.27',
          '203.0.113.28',
          '203.0.113.29',
        ],
        ipsTruncated: true,
      },
    });
    expect(events[1]?.payload).not.toHaveProperty('context');
  } finally {
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
    await prisma.authAuditWindow.deleteMany({ where: { emailHash: hash } });
    await prisma.authAuditBudget.deleteMany({ where: { OR: [{ id: globalId }, { stream: `ws:${org}` }] } });
    await prisma.organization.deleteMany({ where: { id: org } });
    await prisma.user.deleteMany({ where: { id } });
  }
});

it('isolates workspace budgets by namespace and preserves the top 20 targeted members in counted suppression', async () => {
  const previous = auditNamespace(),
    id = randomUUID(),
    org = `qa-namespaces-${id}`,
    email = `qa-namespaces-${id}@example.test`,
    secret = env.BETTER_AUTH_SECRET,
    hash = authEmailHash(email, secret);
  const namespaces = [`${previous}-a`, `${previous}-b`],
    now = new Date('2045-01-01T00:00:01Z'),
    end = new Date('2045-01-01T01:00:00Z');
  try {
    await prisma.user.create({ data: { id, name: 'QA Namespaced Member', email, emailHash: hash } });
    await prisma.organization.create({
      data: {
        id: org,
        name: 'QA Namespaces',
        slug: org,
        createdAt: now,
        members: { create: { id: randomUUID(), userId: id, role: 'member', createdAt: now } },
      },
    });
    for (const namespace of namespaces) {
      process.env.BULLMQ_PREFIX = namespace;
      const budget = `${namespace}:ws:${org}:${+end - 3_600_000}`;
      if (namespace === namespaces[1])
        await prisma.authAuditBudget.create({ data: { id: budget, namespace, stream: `ws:${org}`, windowEnd: end, admitted: 60 } });
      for (let i = 0; i < 3; i++) await stageFailedSignIn(email, 'invalid_otp', { ip: '203.0.113.90' }, secret, now);
      const window = await prisma.authAuditWindow.findFirstOrThrow({ where: { namespace, emailHash: hash } });
      await flushFailedSignIns(now, [window.id]);
      await flushFailedSignIns(new Date(+now + 300_000), [window.id]);
      await flushAuthAuditBudgets(new Date(+end + 1000), [budget]);
    }
    const a = await prisma.auditOutbox.findMany({ where: { namespace: namespaces[0], stream: `ws:${org}` } });
    const b = await prisma.auditOutbox.findMany({ where: { namespace: namespaces[1], stream: `ws:${org}` } });
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    expect(b[0]?.payload).toMatchObject({ action: 'auth.sign_in.suppressed', metadata: { attempts: 3, targets: [{ userId: id, attempts: 3 }] } });
    // A larger workspace's summary stores only the 20 highest counts, with an explicit truncation flag.
    const targets = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`qa-member-${i}`, i + 1]));
    const budget = `${namespaces[1]}:ws:${org}:top20`;
    await prisma.authAuditBudget.create({
      data: { id: budget, namespace: namespaces[1], stream: `ws:${org}`, windowEnd: end, suppressed: 325, targets },
    });
    await flushAuthAuditBudgets(new Date(+end + 1000), [budget]);
    const summary = await prisma.auditOutbox.findUniqueOrThrow({ where: { id: `auth-suppression-${budget}` } });
    const metadata = (summary.payload as { metadata: { targets: { userId: string; attempts: number }[]; targetsTruncated: boolean } }).metadata;
    expect(metadata.targets).toHaveLength(20);
    expect(metadata.targets[0]).toEqual({ userId: 'qa-member-24', attempts: 25 });
    expect(metadata.targetsTruncated).toBe(true);
  } finally {
    process.env.BULLMQ_PREFIX = previous;
    await prisma.auditOutbox.deleteMany({ where: { namespace: { in: namespaces } } });
    await prisma.authAuditWindow.deleteMany({ where: { namespace: { in: namespaces } } });
    await prisma.authAuditBudget.deleteMany({ where: { namespace: { in: namespaces } } });
    await prisma.organization.deleteMany({ where: { id: org } });
    await prisma.user.deleteMany({ where: { id } });
  }
});
