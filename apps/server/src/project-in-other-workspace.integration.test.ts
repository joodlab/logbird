import { randomUUID } from 'node:crypto';
import { prisma } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import { app } from './app';
import { consoleMatrix } from './route-authorization.matrix';

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_PER_MINUTE = '10000';
});

/** Per-request headers: they differ between any two responses, so they are left out of the byte comparison. */
const PER_REQUEST_HEADERS = new Set(['x-request-id', 'date']);

it('answers 409 project_in_other_workspace only to a current member of the owning workspace, and the same 404 to everyone else', async () => {
  const users: string[] = [];
  const organizations: string[] = [];
  const request = (path: string, method = 'GET', cookie = '', body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie, Origin: process.env.APP_URL ?? 'http://localhost:4600', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function login() {
    const email = `t3-workspace-${randomUUID()}@example.invalid`;
    expect((await request('/api/auth/email-otp/send-verification-otp', 'POST', '', { email, type: 'sign-in' })).status).toBe(200);
    const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
    const mailbox = await (await fetch(`${mailpit}/api/v1/messages?limit=100`)).json();
    const message = mailbox.messages.find((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === email));
    const content = await (await fetch(`${mailpit}/api/v1/message/${message.ID}`)).json();
    const response = await request('/api/auth/sign-in/email-otp', 'POST', '', { email, otp: content.Text.match(/\b\d{6}\b/)?.[0] });
    expect(response.status).toBe(200);
    const { user } = await response.json();
    users.push(user.id);
    return {
      id: user.id as string,
      cookie: response.headers
        .getSetCookie()
        .map((v) => v.split(';')[0])
        .join('; '),
    };
  }
  const workspace = async (name: string) => {
    const org = await prisma.organization.create({ data: { id: randomUUID(), name, slug: randomUUID(), createdAt: new Date() } });
    organizations.push(org.id);
    const project = await prisma.project.create({ data: { organizationId: org.id, name: `${name} project`, slug: randomUUID() } });
    return { org, project };
  };
  const join = (userId: string, organizationId: string, role: string) =>
    prisma.member.create({ data: { id: randomUUID(), userId, organizationId, role, createdAt: new Date() } });
  const pathFor = (pattern: string, projectId: string) =>
    pattern
      .replace(':projectId', projectId)
      .replace(/:(?:eventId|id|operationId|entityId|keyId|viewId|deliveryId)/g, 'unknown')
      .replace(':kind', 'actor');
  const comparable = async (response: Response) => ({
    status: response.status,
    body: await response.text(),
    headers: [...response.headers.entries()].filter(([name]) => !PER_REQUEST_HEADERS.has(name)).sort(),
  });

  try {
    const actor = await login();
    const home = await workspace('T3 Home Example');
    const other = await workspace('T3 Other Example');
    const stranger = await workspace('T3 Stranger Example');
    const former = await workspace('T3 Former Example');
    await join(actor.id, home.org.id, 'owner');
    // Any role: a plain member of the owning workspace is told where the project is.
    await join(actor.id, other.org.id, 'member');
    const removed = await join(actor.id, former.org.id, 'admin');
    await prisma.member.delete({ where: { id: removed.id } });
    await prisma.session.updateMany({ where: { userId: actor.id }, data: { activeOrganizationId: home.org.id } });

    const projectRoutes = consoleMatrix.filter(([, path]) => path.includes(':projectId'));
    expect(projectRoutes.length).toBeGreaterThan(0);
    for (const [method, pattern] of projectRoutes) {
      const body = method === 'GET' || method === 'DELETE' ? undefined : {};
      // 1. A current member of the owning workspace, with another workspace active: 409 naming the workspace.
      const conflict = await request(pathFor(pattern, other.project.id), method, actor.cookie, body);
      expect(conflict.status, `${method} ${pattern}: ${conflict.status === 409 ? '' : await conflict.clone().text()}`).toBe(409);
      expect(await conflict.json()).toEqual({
        error: {
          code: 'project_in_other_workspace',
          message: 'This project is in T3 Other Example. Switch to that workspace to open it.',
          details: { workspaceId: other.org.id, workspaceName: 'T3 Other Example' },
        },
      });
      // 2. Not a member (never was, or was removed), and no such project: one indistinguishable 404.
      const missing = await comparable(await request(pathFor(pattern, `missing-${randomUUID()}`), method, actor.cookie, body));
      expect(missing.status, `missing ${method} ${pattern}`).toBe(404);
      for (const [label, projectId] of [
        ['stranger', stranger.project.id],
        ['removed', former.project.id],
      ] as const) {
        const response = await comparable(await request(pathFor(pattern, projectId), method, actor.cookie, body));
        expect(response, `${label} ${method} ${pattern}`).toEqual(missing);
      }
    }

    // A malformed escape in a mutation's project id is the same 404 as a missing project, not a 500.
    const malformed = await comparable(await request('/api/projects/%E0%A4%A', 'PATCH', actor.cookie, {}));
    const missingPatch = await comparable(await request(`/api/projects/missing-${randomUUID()}`, 'PATCH', actor.cookie, {}));
    expect(malformed).toEqual(missingPatch);
    expect(malformed.status).toBe(404);

    // With the owning workspace active the same project opens normally.
    await prisma.session.updateMany({ where: { userId: actor.id }, data: { activeOrganizationId: other.org.id } });
    const opened = await request(`/api/projects/${other.project.id}`, 'GET', actor.cookie);
    expect(opened.status).toBe(200);
    await opened.text();
    // A forged active workspace the person is not a member of never turns into a 409 for it, nor reveals it.
    await prisma.session.updateMany({ where: { userId: actor.id }, data: { activeOrganizationId: stranger.org.id } });
    const forged = await comparable(await request(`/api/projects/${stranger.project.id}`, 'GET', actor.cookie));
    const none = await comparable(await request(`/api/projects/missing-${randomUUID()}`, 'GET', actor.cookie));
    expect(forged).toEqual(none);
    expect(none.status).toBe(404);
  } finally {
    for (const organization of organizations) await prisma.organization.deleteMany({ where: { id: organization } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
}, 120_000);
