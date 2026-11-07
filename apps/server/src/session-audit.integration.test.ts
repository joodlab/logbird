import { createHmac, randomUUID } from 'node:crypto';
import { auth } from '@logbird/auth';
import { auditNamespace, prisma } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import { app } from './app';
import { env } from './env';
import { deliverOutboxEvent, sweepAuditRetention } from './outbox-delivery';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const control = vi.hoisted(() => ({ beforeInsert: undefined as undefined | (() => Promise<void>) }));
vi.mock('@logbird/database', async (original) => {
  const actual = await original<typeof import('@logbird/database')>();
  return {
    ...actual,
    storeAuditEvent: async (...args: Parameters<typeof actual.storeAuditEvent>) => {
      if (args[1].action === 'auth.session.revoked' || args[1].action === 'auth.signed_out') await control.beforeInsert?.();
      return actual.storeAuditEvent(...args);
    },
  };
});
const cookieFor = (token: string) =>
  `logbird.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', env.BETTER_AUTH_SECRET).update(token).digest('base64')}`)}`;
async function fixture() {
  const userId = randomUUID(),
    org = `qa-session-${userId}`,
    email = `qa-session-${userId}@example.test`;
  await prisma.user.create({ data: { id: userId, name: 'QA Session Owner', email, emailVerified: true } });
  await prisma.organization.create({
    data: {
      id: org,
      name: 'QA Sessions',
      slug: org,
      createdAt: new Date(),
      members: { create: { id: randomUUID(), userId, role: 'member', createdAt: new Date() } },
    },
  });
  const create = () =>
    prisma.session.create({
      data: {
        id: randomUUID(),
        userId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
        ipAddress: '203.0.113.49',
        userAgent: 'QA revoked device',
      },
    });
  const actor = await create();
  const request = (path: string, body?: unknown, cookie = cookieFor(actor.token), origin = env.APP_URL) =>
    app.request(path, {
      method: 'POST',
      headers: { cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    userId,
    org,
    email,
    actor,
    create,
    request,
    rows: () => prisma.auditOutbox.findMany({ where: { stream: `ws:${org}` } }),
    cleanup: async () => {
      control.beforeInsert = undefined;
      await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
      await prisma.organization.deleteMany({ where: { id: org } });
      await prisma.user.deleteMany({ where: { id: userId } });
    },
  };
}

it('owns all four endpoints, enforces self-only policy without an active workspace, and clears native cookies', async () => {
  const f = await fixture(),
    foreignId = randomUUID();
  try {
    const one = await f.create(),
      two = await f.create();
    await prisma.user.create({ data: { id: foreignId, name: 'QA Foreign Session', email: `qa-foreign-${foreignId}@example.test` } });
    const foreign = await prisma.session.create({
      data: { id: randomUUID(), userId: foreignId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    for (const path of ['/api/session/sign-out', '/api/sessions/revoke', '/api/sessions/revoke-all', '/api/sessions/revoke-others']) {
      expect((await f.request(path, { sessionId: one.id }, '')).status).toBe(401);
      expect((await f.request(path, { sessionId: one.id }, undefined, 'https://foreign.example.test')).status).toBe(403);
    }
    for (const path of ['sign-out', 'revoke-session', 'revoke-sessions', 'revoke-other-sessions'])
      for (const suffix of ['', '/']) expect((await f.request(`/api/auth/${path}${suffix}`, { token: one.token })).status).toBe(409);
    expect((await f.request('/api/sessions/revoke', { sessionId: foreign.id })).status).toBe(404);
    expect(await prisma.session.findUnique({ where: { id: foreign.id } })).not.toBeNull();
    expect((await f.request('/api/sessions/revoke', { token: one.token })).status).toBe(400);
    expect((await f.request('/api/sessions/revoke', { sessionId: one.id })).status).toBe(200);
    expect((await f.request('/api/sessions/revoke-others')).status).toBe(200);
    expect(await prisma.session.findUnique({ where: { id: two.id } })).toBeNull();
    const signOut = await f.request(
      '/api/session/sign-out',
      undefined,
      `${cookieFor(f.actor.token)}; logbird.session_data.0=stale; logbird.session_data.1=stale`,
    );
    expect(signOut.status).toBe(200);
    const cookies = signOut.headers.getSetCookie().join('\n');
    for (const name of ['session_token', 'session_data', 'session_data.0', 'session_data.1']) expect(cookies).toContain(`logbird.${name}=;`);
    expect(cookies).toContain('Max-Age=0');
    expect((await f.request('/api/session/sign-out')).status).toBe(401);
    const rows = await f.rows();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => (row.payload as { targets: { id: string }[] }).targets[0]?.id).sort()).toEqual([one.id, two.id, f.actor.id].sort());
    expect(rows.every((row) => row.confirmedAt && !row.sourceSessionId)).toBe(true);
    for (const row of rows) {
      expect(row.payload).toMatchObject({ metadata: { session: { ipAddress: '203.0.113.49', userAgent: 'QA revoked device' } } });
      for (const token of [one.token, two.token, f.actor.token, foreign.token]) expect(JSON.stringify(row.payload)).not.toContain(token);
    }
  } finally {
    await f.cleanup();
    await prisma.user.deleteMany({ where: { id: foreignId } });
  }
});

it('rolls deletion and evidence back on a pre-commit crash; a lost post-commit response preserves both', async () => {
  const f = await fixture();
  try {
    const other = await f.create();
    control.beforeInsert = async () => {
      throw new Error('Injected crash before commit');
    };
    expect((await f.request('/api/sessions/revoke-all')).status).toBe(503);
    expect(await prisma.session.count({ where: { userId: f.userId } })).toBe(2);
    expect(await f.rows()).toEqual([]);
    control.beforeInsert = undefined;
    await f.request('/api/sessions/revoke-all'); // Discard the response as if the connection/process were lost.
    expect(await prisma.session.count({ where: { userId: f.userId } })).toBe(0);
    const rows = await f.rows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => (row.payload as { targets: { id: string }[] }).targets[0]?.id).sort()).toEqual([f.actor.id, other.id].sort());
    for (const row of rows) {
      await deliverOutboxEvent(row.id, async (_stream, event) => {
        expect(event).toEqual(row.payload);
        return { accepted: 1, rejected: [] };
      });
      expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: row.id } })).deliveredAt).not.toBeNull();
    }
  } finally {
    await f.cleanup();
  }
});

it('a real OTP sign-in between revoke-all selection and commit survives with no unaudited deletion', async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred();
  let ending: Promise<Response> | undefined;
  try {
    const other = await f.create();
    const otp = await auth.api.createVerificationOTP({ body: { email: f.email, type: 'sign-in' } });
    control.beforeInsert = async () => {
      entered.resolve();
      await release.promise;
    };
    ending = Promise.resolve(f.request('/api/sessions/revoke-all'));
    await entered.promise; // DELETE executed inside the still-open transaction, before its outbox INSERT.
    const signInPending = f.request('/api/auth/sign-in/email-otp', { email: f.email, otp }, '');
    const signedIn = await signInPending;
    expect(signedIn.status).toBe(200);
    const freshCookie = signedIn.headers
      .getSetCookie()
      .map((s) => s.split(';')[0])
      .join('; ');
    release.resolve();
    expect((await ending).status).toBe(200);
    expect((await app.request('/api/me', { headers: { cookie: freshCookie } })).status).toBe(200);
    const surviving = await prisma.session.findMany({ where: { userId: f.userId } });
    expect(surviving).toHaveLength(1);
    expect([other.id, f.actor.id]).not.toContain(surviving[0]?.id);
    const ends = (await f.rows()).filter((row) => (row.payload as { action: string }).action === 'auth.session.revoked');
    expect(ends.map((row) => (row.payload as { targets: { id: string }[] }).targets[0]?.id).sort()).toEqual([other.id, f.actor.id].sort());
  } finally {
    release.resolve();
    await ending;
    await f.cleanup();
  }
});

it('neutralizes ambiguous old hook intents without deleting or confirming their evidence', async () => {
  const id = randomUUID();
  try {
    await prisma.auditOutbox.create({
      data: {
        id,
        namespace: auditNamespace(),
        stream: 'ws:qa-legacy-session',
        payload: { action: 'auth.session.revoked' },
        confirmedAt: null,
        sourceSessionId: randomUUID(),
      },
    });
    await sweepAuditRetention();
    expect(await prisma.auditOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({
      confirmedAt: null,
      deliveredAt: null,
      lastError: 'legacy_session_intent',
    });
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id } })).quarantinedAt).not.toBeNull();
  } finally {
    await prisma.auditOutbox.deleteMany({ where: { id } });
  }
});
