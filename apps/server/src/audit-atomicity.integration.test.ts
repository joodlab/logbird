import { createHmac, randomUUID } from 'node:crypto';
import { prisma } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import { app } from './app';
import { env } from './env';

const control = vi.hoisted(() => ({ fail: false }));
vi.mock('@logbird/database', async (original) => {
  const db = await original<typeof import('@logbird/database')>();
  return {
    ...db,
    storeAuditEvent: async (...args: Parameters<typeof db.storeAuditEvent>) => {
      if (control.fail) throw new Error('injected outbox INSERT failure');
      return db.storeAuditEvent(...args);
    },
  };
});

it('rolls back every owned mutation when its outbox insert fails, including all project-delete key revocations', async () => {
  const id = randomUUID(),
    org = `qa-atomic-${id}`,
    outsider = randomUUID();
  const request = (path: string, method: string, body?: unknown, cookieOverride?: string) =>
    app.request(path, {
      method,
      headers: { cookie: cookieOverride ?? cookie, Origin: env.APP_URL, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let cookie = '';
  const cookieFor = (token: string) =>
    `logbird.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', env.BETTER_AUTH_SECRET).update(token).digest('base64')}`)}`;
  try {
    for (const userId of [id, outsider])
      await prisma.user.create({ data: { id: userId, name: 'QA Atomic', email: `qa-atomic-${userId}@example.test` } });
    await prisma.organization.create({
      data: {
        id: org,
        name: 'QA Atomic',
        slug: org,
        createdAt: new Date(),
        members: { create: { id: randomUUID(), userId: id, role: 'owner', createdAt: new Date() } },
      },
    });
    const token = randomUUID();
    await prisma.session.create({
      data: { id: randomUUID(), userId: id, token, expiresAt: new Date(Date.now() + 3_600_000), activeOrganizationId: org },
    });
    cookie = cookieFor(token);
    const otherToken = randomUUID();
    await prisma.session.create({ data: { id: randomUUID(), userId: outsider, token: otherToken, expiresAt: new Date(Date.now() + 3_600_000) } });
    const project = await prisma.project.create({ data: { name: 'QA Atomic Project', slug: `qa-project-${id}`, organizationId: org } });
    const key = await prisma.apiKey.create({
      data: { projectId: project.id, name: 'QA Atomic key', kind: 'read', hash: randomUUID(), prefix: 'qa' },
    });
    const view = await prisma.savedView.create({
      data: { projectId: project.id, name: 'QA Atomic view', createdById: id, state: { q: '', range: '24h' } },
    });
    const link = await prisma.inviteLink.create({
      data: { organizationId: org, token: randomUUID(), role: 'member', expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const snapshot = async () =>
      JSON.stringify({
        org: await prisma.organization.findUnique({ where: { id: org } }),
        projects: await prisma.project.findMany({ where: { organizationId: org } }),
        keys: await prisma.apiKey.findMany({ where: { projectId: project.id } }),
        views: await prisma.savedView.findMany({ where: { projectId: project.id } }),
        links: await prisma.inviteLink.findMany({ where: { organizationId: org } }),
        members: await prisma.member.findMany({ where: { organizationId: org } }),
        session: await prisma.session.findFirst({ where: { userId: outsider }, select: { id: true, activeOrganizationId: true } }),
        outbox: await prisma.auditOutbox.count({ where: { stream: `ws:${org}` } }),
      });
    const before = await snapshot(),
      base = `/api/projects/${project.id}`;
    control.fail = true;
    const cases: [string, string, unknown?, string?][] = [
      ['/api/projects', 'POST', { name: 'QA Atomic new' }],
      [base, 'PATCH', { name: 'QA changed', retentionDays: 180, retentionReviewed: true, setupDismissed: true }],
      [`${base}/keys`, 'POST', { name: 'QA key', kind: 'ingest' }],
      [`${base}/keys/${key.id}`, 'DELETE'],
      [`${base}/views`, 'POST', { name: 'QA new view', description: null, state: { q: '', range: '24h', columns: ['time', 'action'] } }],
      [`${base}/views/${view.id}`, 'DELETE'],
      ['/api/workspace/invite-links', 'POST', { role: 'member', expiresInDays: 7 }],
      [`/api/workspace/invite-links/${link.id}`, 'DELETE'],
      [`/api/invite-links/${link.token}/accept`, 'POST', {}, cookieFor(otherToken)],
      ['/api/workspace', 'PATCH', { name: 'QA Changed workspace', slug: `qa-changed-${id}` }],
      [`${base}?confirm=${project.slug}`, 'DELETE'],
    ];
    for (const [path, method, body, cookie] of cases) {
      const response = await request(path, method, body, cookie);
      expect(response.status, `${method} ${path}`).toBe(503);
      expect((await response.json()).error.code).toBe('audit_storage_unavailable');
      const after = await snapshot();
      if (path === `${base}?confirm=${project.slug}`) {
        const actual = JSON.parse(after),
          expected = JSON.parse(before);
        const actualProject = actual.projects.find((row: { id: string }) => row.id === project.id);
        const expectedProject = expected.projects.find((row: { id: string }) => row.id === project.id);
        expect(actualProject.exportDeleteStartedAt).not.toBeNull();
        expect(actualProject.exportGeneration).toBe(expectedProject.exportGeneration + 1);
        expect(new Date(actualProject.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(expectedProject.updatedAt).getTime());
        // Purge precedes the owned delete transaction. Keep its internal fence even on failure;
        // every business field, key revocation, membership and outbox change must still roll back.
        Object.assign(actualProject, {
          exportDeleteStartedAt: expectedProject.exportDeleteStartedAt,
          exportGeneration: expectedProject.exportGeneration,
          updatedAt: expectedProject.updatedAt,
        });
        expect(JSON.stringify(actual), `${method} ${path} business state rolled back`).toBe(before);
      } else expect(after, `${method} ${path} rolled back`).toBe(before);
    }
    control.fail = false;
    expect((await request('/api/workspace', 'PATCH', { name: 'QA Changed workspace' })).status).toBe(200);
    expect(await prisma.auditOutbox.count({ where: { stream: `ws:${org}` } })).toBe(1);
    expect((await request('/api/auth/organization/update', 'POST', { organizationId: org, data: { name: 'QA bypass' } })).status).toBe(403);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org } })).name).toBe('QA Changed workspace');
  } finally {
    control.fail = false;
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
    await prisma.organization.deleteMany({ where: { id: org } });
    await prisma.user.deleteMany({ where: { id: { in: [id, outsider] } } });
  }
});
