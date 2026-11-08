import { randomUUID } from 'node:crypto';
import { auditNamespace, prisma, storeAuditEvent, withProjectLock } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import { AUTH_AUDIT_GLOBAL_LIMIT, authEmailHash, flushAuthAuditBudgets, flushFailedSignIns, stageFailedSignIn } from './auth-failures';
import { auditDrainStatus, claimAuditEvents, deliverOutboxEvent, drainAuditOutbox, startAuditDrainer } from './outbox-delivery';

it('persists across restart, independently retries destinations, and never changes an ambiguous payload', async () => {
  const prefix = `qa-outbox-${randomUUID()}`;
  const ids: [string, string] = [`${prefix}-a`, `${prefix}-b`];
  const clock = new Date();
  try {
    await storeAuditEvent(`ws:${prefix}-a`, { id: ids[0], action: 'auth.signed_out', targets: [{ type: 'session', id: 'non-secret' }] });
    await storeAuditEvent(`ws:${prefix}-b`, { id: ids[1], action: 'auth.signed_out' });
    // No in-memory promise/job survives this boundary; reconciliation rediscovers both stored rows.
    const queued = await claimAuditEvents(new Date(clock.getTime() + 1000));
    expect(
      queued
        .filter((row) => ids.includes(row.id))
        .map((row) => row.id)
        .sort(),
    ).toEqual(ids);
    // A crashed claimant leaves a lease, which a restarted replica may reclaim only after expiry.
    expect(await claimAuditEvents(new Date(clock.getTime() + 2000))).toHaveLength(0);
    await prisma.auditOutbox.updateMany({ where: { id: { in: ids } }, data: { nextAttemptAt: clock } });
    const payloads: string[] = [];
    const sink = vi.fn(async (stream, event) => {
      if (stream.endsWith('-a')) {
        payloads.push(JSON.stringify(event));
        throw Object.assign(new Error('safe test'), { code: 'ingest_pending' });
      }
      return { accepted: 1, rejected: [] };
    });
    await Promise.all(ids.map((id) => deliverOutboxEvent(id, sink, new Date(clock.getTime() + 1000))));
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: ids[1] } })).deliveredAt).not.toBeNull();
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: ids[0] } })).lastError).toBe('ingest_pending');
    await deliverOutboxEvent(
      ids[0],
      async (_stream, event) => {
        payloads.push(JSON.stringify(event));
        return { accepted: 1, rejected: [] };
      },
      new Date(clock.getTime() + 70_000),
    );
    expect(payloads[1]).toBe(payloads[0]);
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: ids[0] } })).deliveredAt).not.toBeNull();
  } finally {
    await prisma.auditOutbox.deleteMany({ where: { id: { in: ids } } });
  }
});

it('retains conflicts and non-throwing rejection as undelivered with safe errors', async () => {
  const id = randomUUID();
  try {
    await storeAuditEvent(`ws:qa-${id}`, { id, action: 'auth.session.revoked' });
    await deliverOutboxEvent(id, async () => ({
      accepted: 0,
      rejected: [{ reason: 'duplicate_id_conflict: secret must never appear in lastError' }],
    }));
    expect(await prisma.auditOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({
      deliveredAt: null,
      lastError: 'duplicate_id_conflict',
      attempts: 1,
    });
    await deliverOutboxEvent(
      id,
      async () => {
        throw new Error('secret');
      },
      new Date(Date.now() + 70_000),
    );
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id } })).lastError).toBe('audit_storage_unavailable');
  } finally {
    await prisma.auditOutbox.deleteMany({ where: { id } });
  }
});

it('all 16 lock slots can enqueue without a nested lock acquisition', async () => {
  const prefix = `qa-pool-${randomUUID()}`;
  let admitted = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await Promise.all(
      Array.from({ length: 16 }, (_, n) =>
        withProjectLock(`${prefix}-${n}`, async () => {
          if (++admitted === 16) release();
          await ready;
          await storeAuditEvent(`ws:${prefix}`, { id: `${prefix}-${n}`, action: 'organization.updated' });
        }),
      ),
    );
    expect(await prisma.auditOutbox.count({ where: { stream: `ws:${prefix}` } })).toBe(16);
  } finally {
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${prefix}` } });
  }
});

it('counts suppressed attempts, targets known members, fans out atomically, and bounds fresh identities', async () => {
  const id = randomUUID();
  const email = `qa-fix-budget-${id}@example.test`;
  const secret = 'test-auth-audit-secret-never-used-in-production';
  const now = new Date('2041-01-01T00:00:01Z');
  const globalId = `${auditNamespace()}:global:${Math.floor(now.getTime() / 3_600_000)}`;
  const context = { requestId: id, ip: '203.0.113.200' };
  const orgs = [`qa-${id}-a`, `qa-${id}-b`];
  const hash = authEmailHash(email, secret);
  try {
    await prisma.user.create({ data: { id, name: 'QA Target Member', email, emailHash: hash } });
    for (const org of orgs)
      await prisma.organization.create({
        data: {
          id: org,
          name: 'QA Budget',
          slug: org,
          createdAt: new Date(),
          members: { create: { id: randomUUID(), userId: id, role: 'member', createdAt: new Date() } },
        },
      });
    for (let i = 0; i < 5; i++) await stageFailedSignIn(email, 'invalid_otp', context, secret, now);
    const staged = await prisma.authAuditWindow.findFirstOrThrow({ where: { id: { startsWith: hash } } });
    expect(JSON.stringify(staged)).not.toContain(email);
    const workspaceBudget = `${auditNamespace()}:ws:${orgs[1]}:${Math.floor(now.getTime() / 3_600_000) * 3_600_000}`;
    // Workspace budgets are resolved only during preparation; seed this destination near its limit.
    await prisma.authAuditBudget.create({
      data: {
        id: workspaceBudget,
        namespace: auditNamespace(),
        stream: `ws:${orgs[1]}`,
        windowEnd: new Date(Math.floor(+now / 3_600_000) * 3_600_000 + 3_600_000),
        admitted: 59,
      },
    });
    await flushFailedSignIns(now, [staged.id]);
    await flushFailedSignIns(new Date(now.getTime() + 300_000), [staged.id]);
    {
      const org = orgs[0];
      const events = await prisma.auditOutbox.findMany({ where: { stream: `ws:${org}` }, orderBy: { createdAt: 'asc' } });
      expect(events).toHaveLength(2);
      expect(events.map((r) => (r.payload as { metadata: { attempts: number } }).metadata.attempts)).toEqual([1, 4]);
      expect(events[0]?.payload).toMatchObject({ targets: [{ type: 'user', id, name: 'QA Target Member' }] });
    }
    expect(await prisma.auditOutbox.count({ where: { stream: `ws:${orgs[1]}` } })).toBe(1);
    expect((await prisma.authAuditBudget.findUniqueOrThrow({ where: { id: workspaceBudget } })).suppressed).toBe(4);
    await flushAuthAuditBudgets(new Date('2041-01-01T01:00:01Z'), [workspaceBudget]);
    const summary = await prisma.auditOutbox.findFirstOrThrow({
      where: { stream: `ws:${orgs[1]}`, payload: { path: ['action'], equals: 'auth.sign_in.suppressed' } },
    });
    expect((summary.payload as { metadata: { attempts: number } }).metadata.attempts).toBe(4);
    await prisma.authAuditBudget.update({ where: { id: globalId }, data: { admitted: AUTH_AUDIT_GLOBAL_LIMIT } });
    for (let i = 0; i < 3; i++) await stageFailedSignIn(`qa-fresh-${i}-${id}@example.test`, 'invalid_otp', context, secret, now);
    expect((await prisma.authAuditBudget.findUniqueOrThrow({ where: { id: globalId } })).suppressed).toBe(3);
    expect(await prisma.authAuditWindow.count({ where: { context: { path: ['requestId'], equals: id } } })).toBe(4);
  } finally {
    await prisma.auditOutbox.deleteMany({ where: { stream: { in: orgs.map((org) => `ws:${org}`) } } });
    await prisma.authAuditWindow.deleteMany({ where: { id: { startsWith: hash } } });
    await prisma.authAuditBudget.deleteMany({ where: { OR: [{ id: globalId }, ...orgs.map((org) => ({ stream: `ws:${org}` }))] } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
    await prisma.user.deleteMany({ where: { id } });
  }
});

it('stops claiming, drains in-flight server delivery, and restarts pending work', async () => {
  const first = randomUUID(),
    second = randomUUID();
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let drainer: ReturnType<typeof startAuditDrainer> | undefined;
  let restarted: ReturnType<typeof startAuditDrainer> | undefined;
  try {
    await storeAuditEvent('ws:qa-shutdown', { id: first, action: 'auth.signed_out' });
    drainer = startAuditDrainer(async () => {
      started();
      await blocked;
      return { accepted: 1, rejected: [] };
    });
    await entered;
    let closed = false;
    const closing = drainer.stop().then(() => {
      closed = true;
    });
    await storeAuditEvent('ws:qa-shutdown', { id: second, action: 'auth.session.revoked' });
    expect(closed).toBe(false);
    release();
    await closing;
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: first } })).deliveredAt).not.toBeNull();
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: second } })).deliveredAt).toBeNull();
    restarted = startAuditDrainer(async () => ({ accepted: 1, rejected: [] }));
    await vi.waitFor(async () => expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: second } })).deliveredAt).not.toBeNull());
  } finally {
    release();
    await drainer?.stop();
    await restarted?.stop();
    await prisma.auditOutbox.deleteMany({ where: { id: { in: [first, second] } } });
  }
});

it('competing replicas skip locked claims and recover expired leases', async () => {
  const ids: string[] = [randomUUID(), randomUUID()];
  try {
    for (const id of ids) await storeAuditEvent('ws:qa-replicas', { id, action: 'auth.signed_out' });
    const [a, b] = await Promise.all([claimAuditEvents(), claimAuditEvents()]);
    expect([...a, ...b].filter((r) => ids.includes(r.id))).toHaveLength(2);
    expect(a.filter((r) => b.some((other) => other.id === r.id))).toHaveLength(0);
    const recovered = await claimAuditEvents(new Date(Date.now() + 61_000));
    expect(recovered.filter((r) => ids.includes(r.id))).toHaveLength(2);
  } finally {
    await prisma.auditOutbox.deleteMany({ where: { id: { in: ids } } });
  }
});

it('delivers through local ingest against real ClickHouse independently per workspace', async () => {
  const { ingest } = await import('./ingest');
  const { clickhouse } = await import('./clickhouse');
  const { purgeProject } = await import('@logbird/clickhouse');
  const orgs = [randomUUID(), randomUUID()];
  const streams = orgs.map((org) => `ws:${org}`);
  const ids = [randomUUID(), randomUUID()];
  try {
    await prisma.organization.createMany({
      data: orgs.map((id) => ({ id, name: 'QA Durable Delivery', slug: id, createdAt: new Date() })),
    });
    for (let i = 0; i < 2; i++)
      await storeAuditEvent(streams[i] ?? '', { id: ids[i], action: 'auth.signed_out', description: 'QA durable delivery' });
    await Promise.all(
      ids.map((id) =>
        deliverOutboxEvent(id, async (stream, event) => {
          if (stream === streams[0]) throw Object.assign(new Error('ambiguous acknowledgement'), { code: 'ingest_pending' });
          return ingest(stream, event);
        }),
      ),
    );
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: ids[0] } })).lastError).toBe('ingest_pending');
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: ids[1] } })).deliveredAt).not.toBeNull();
    await deliverOutboxEvent(ids[0] ?? '', ingest, new Date(Date.now() + 70_000));
    for (let i = 0; i < 2; i++) {
      const source = await prisma.auditOutbox.findUniqueOrThrow({ where: { id: ids[i] } });
      expect(source.deliveredAt).not.toBeNull();
      const rows = await (
        await clickhouse.query({
          query: 'SELECT payload FROM events WHERE project_id={p:String}',
          query_params: { p: streams[i] },
          format: 'JSONEachRow',
        })
      ).json<{ payload: string }>();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]?.payload ?? '{}')).toEqual(source.payload);
    }
  } finally {
    for (const stream of streams) await purgeProject(clickhouse, stream);
    await prisma.auditOutbox.deleteMany({ where: { id: { in: ids } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
  }
});

it('quarantines deleted-workspace evidence after bounded real-ingest failures while healthy workspaces deliver', async () => {
  const { ingest } = await import('./ingest');
  const { clickhouse } = await import('./clickhouse');
  const { purgeProject } = await import('@logbird/clickhouse');
  const orgs = [randomUUID(), randomUUID()];
  const streams = orgs.map((org) => `ws:${org}`);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const secret = 'QA event description must not enter delivery diagnostics';
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await prisma.organization.createMany({
      data: orgs.map((id) => ({ id, name: 'QA Deleted Workspace Delivery', slug: id, createdAt: new Date() })),
    });
    await storeAuditEvent(streams[0] ?? '', { id: ids[0], action: 'organization.updated', description: secret });
    await prisma.$transaction(async (tx) => {
      await tx.organization.delete({ where: { id: orgs[0] } });
      await storeAuditEvent(streams[0] ?? '', { id: ids[1], action: 'organization.deleted', description: secret }, tx);
    });
    await storeAuditEvent(streams[1] ?? '', { id: ids[2], action: 'organization.updated' });
    const now = new Date(Date.now() + 1000);
    // Each sweep claims at most two rows; failed destinations cannot monopolize the next sweep.
    await drainAuditOutbox(ingest, now);
    await drainAuditOutbox(ingest, now);
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: ids[2] } })).deliveredAt).not.toBeNull();

    for (const id of ids.slice(0, 2)) {
      for (let attempt = 1; attempt < 10; attempt++) await deliverOutboxEvent(id, ingest, new Date(+now + attempt * 7_200_000));
      expect(await prisma.auditOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({
        attempts: 10,
        deliveredAt: null,
        lastError: 'audit_storage_unavailable',
        quarantinedAt: expect.any(Date),
      });
      expect(await claimAuditEvents(new Date(+now + 100 * 7_200_000), id)).toHaveLength(0);
    }
    expect(await auditDrainStatus()).toMatchObject({ undelivered: 2, quarantined: 2 });
    expect(await prisma.ingestReceipt.count({ where: { projectId: streams[0] } })).toBe(0);
    const diagnostics = warnings.mock.calls.map(([line]) => JSON.parse(String(line))).filter((row) => row.event === 'audit.delivery_failed');
    expect(diagnostics).toHaveLength(20);
    expect(diagnostics.every((row) => row.lastError === 'audit_storage_unavailable')).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    const healthyRows = await (
      await clickhouse.query({
        query: 'SELECT count() n FROM events WHERE project_id={p:String}',
        query_params: { p: streams[1] },
        format: 'JSONEachRow',
      })
    ).json<{ n: number }>();
    expect(Number(healthyRows[0]?.n)).toBe(1);
  } finally {
    warnings.mockRestore();
    for (const stream of streams) await purgeProject(clickhouse, stream);
    await prisma.auditOutbox.deleteMany({ where: { id: { in: ids } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
  }
});
