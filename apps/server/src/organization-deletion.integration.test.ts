import { randomUUID } from 'node:crypto';
import { purgeProject } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import { app } from './app';
import { clickhouse } from './clickhouse';
import { ingest } from './ingest';

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_PER_MINUTE = '10000';
});

const eventsOf = async (projectId: string) =>
  Number(
    (
      await (
        await clickhouse.query({
          query: 'SELECT count() AS n FROM events WHERE project_id = {projectId:String}',
          query_params: { projectId },
          format: 'JSONEachRow',
        })
      ).json<{ n: string }>()
    )[0]?.n ?? 0,
  );

it('refuses to delete a workspace, even for its owner, and keeps the workspace, its project and their events', async () => {
  const users: string[] = [];
  let organizationId: string | undefined;
  let projectId: string | undefined;
  const request = (path: string, method = 'GET', cookie = '', body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie, Origin: process.env.APP_URL ?? 'http://localhost:4600', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    // A real owner: signed in by code, workspace created through better-auth, project through the console API.
    const email = `t3-delete-${randomUUID()}@example.invalid`;
    expect((await request('/api/auth/email-otp/send-verification-otp', 'POST', '', { email, type: 'sign-in' })).status).toBe(200);
    const mailpit = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
    const mailbox = await (await fetch(`${mailpit}/api/v1/messages?limit=100`)).json();
    const message = mailbox.messages.find((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === email));
    const content = await (await fetch(`${mailpit}/api/v1/message/${message.ID}`)).json();
    const signIn = await request('/api/auth/sign-in/email-otp', 'POST', '', { email, otp: content.Text.match(/\b\d{6}\b/)?.[0] });
    expect(signIn.status).toBe(200);
    users.push((await signIn.json()).user.id);
    const cookie = signIn.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
    const created = await request('/api/auth/organization/create', 'POST', cookie, {
      name: 'T3 Deletion Example',
      slug: `t3-deletion-${randomUUID()}`,
    });
    expect(created.status).toBe(200);
    organizationId = (await created.json()).id as string;
    expect((await request('/api/auth/organization/set-active', 'POST', cookie, { organizationId })).status).toBe(200);
    const project = await request('/api/projects', 'POST', cookie, { name: 'T3 Deletion Booking API', retentionDays: 90 });
    expect(project.status).toBe(201);
    projectId = (await project.json()).project.id as string;
    await ingest(projectId, { id: `t3-delete-${randomUUID()}`, action: 'booking.created', actor: { id: 'actor-1' } });
    await vi.waitFor(async () => expect(await eventsOf(projectId as string)).toBe(1), { timeout: 30_000 });
    const owner = await prisma.member.findFirstOrThrow({ where: { organizationId, userId: users[0] } });
    expect(owner.role).toBe('owner');

    // The owner asks better-auth to delete the workspace: refused.
    const deleted = await request('/api/auth/organization/delete', 'POST', cookie, { organizationId });
    expect(deleted.status).toBe(404);
    expect((await deleted.json()).code).toBe('ORGANIZATION_DELETION_DISABLED');

    // Nothing went: the workspace, its project and the project's events.
    expect(await prisma.organization.findUnique({ where: { id: organizationId } })).not.toBeNull();
    expect(await prisma.project.findUnique({ where: { id: projectId } })).not.toBeNull();
    expect(await eventsOf(projectId)).toBe(1);
    // And the project still opens for its owner.
    expect((await request(`/api/projects/${projectId}`, 'GET', cookie)).status).toBe(200);
  } finally {
    if (projectId) await purgeProject(clickhouse, projectId);
    if (organizationId) {
      await purgeProject(clickhouse, `ws:${organizationId}`);
      await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${organizationId}` } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    if (projectId) expect(await eventsOf(projectId)).toBe(0);
  }
}, 120_000);
