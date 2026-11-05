import { randomUUID } from 'node:crypto';
import { purgeProject } from '@trailmark/clickhouse';
import { createApiKeyResponseSchema, createProjectResponseSchema, savedViewSchema } from '@trailmark/contracts';
import { prisma } from '@trailmark/database';
import { expect, it } from 'vitest';
import { app } from './app';
import { clickhouse } from './clickhouse';

it('real services: every console mutation by role, ADMIN-1 regressions, confirmation and cross-workspace isolation', async () => {
  const users: string[] = [],
    orgs: string[] = [],
    projects: string[] = [];
  const request = (cookie: string, path: string, method = 'GET', body?: unknown) => {
    const init = {
      method,
      headers: { cookie, 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    return process.env.AUTHZ_SERVER_URL ? fetch(`${process.env.AUTHZ_SERVER_URL}${path}`, init) : app.request(path, init);
  };
  async function login() {
    const email = `authz-${randomUUID()}@example.test`;
    expect((await request('', '/api/auth/email-otp/send-verification-otp', 'POST', { email, type: 'sign-in' })).status).toBe(200);
    const mailbox = (await (await fetch('http://127.0.0.1:8025/api/v1/messages?limit=100')).json()) as {
      messages: { ID: string; To: { Address: string }[] }[];
    };
    const message = mailbox.messages.find((m) => m.To.some((t) => t.Address === email));
    const content = (await (await fetch(`http://127.0.0.1:8025/api/v1/message/${message?.ID}`)).json()) as { Text: string };
    const response = await request('', '/api/auth/sign-in/email-otp', 'POST', { email, otp: content.Text.match(/\b\d{6}\b/)?.[0] });
    expect(response.status).toBe(200);
    const { user } = (await response.json()) as { user: { id: string } };
    users.push(user.id);
    return {
      id: user.id,
      cookie: response.headers
        .getSetCookie()
        .map((v) => v.split(';')[0])
        .join('; '),
    };
  }
  try {
    const actor = await login(),
      other = await login();
    const organization = await prisma.organization.create({
      data: { id: randomUUID(), name: 'Authorization fixture', slug: randomUUID(), createdAt: new Date() },
    });
    orgs.push(organization.id);
    const membership = await prisma.member.create({
      data: { id: randomUUID(), organizationId: organization.id, userId: actor.id, role: 'owner', createdAt: new Date() },
    });
    await request(actor.cookie, '/api/auth/organization/set-active', 'POST', { organizationId: organization.id });
    const outsiderOrg = await prisma.organization.create({
      data: { id: randomUUID(), name: 'Other workspace', slug: randomUUID(), createdAt: new Date() },
    });
    orgs.push(outsiderOrg.id);
    const outsiderProject = await prisma.project.create({ data: { organizationId: outsiderOrg.id, name: 'Private project', slug: randomUUID() } });
    projects.push(outsiderProject.id);
    const p = await prisma.project.create({ data: { organizationId: organization.id, name: 'Authorization project', slug: randomUUID() } });
    projects.push(p.id);
    const base = `/api/projects/${p.id}`;
    for (const role of ['owner', 'admin', 'member', 'member, admin']) {
      await prisma.member.update({ where: { id: membership.id }, data: { role } });
      const member = role === 'member';
      await prisma.project.update({ where: { id: p.id }, data: { retentionDays: 90 } });
      const before = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
      const me = (await (await request(actor.cookie, '/api/me')).json()) as { organizations: { id: string; role: string }[] };
      expect(me.organizations.find((o) => o.id === organization.id)?.role).toBe(role);
      const check = async (path: string, method: string, body: unknown, status: number, administrative = true) => {
        const r = await request(actor.cookie, path, method, body);
        expect(r.status, `${role} ${method} ${path}`).toBe(member && administrative ? 403 : status);
        if (member && administrative)
          expect(await r.clone().json()).toEqual({ error: { code: 'forbidden', message: 'Workspace owner or admin access required.' } });
        return r;
      };
      const created = await check('/api/projects', 'POST', { name: 'Disposable authz project', retentionDays: 90 }, 201);
      if (!member) {
        const result = createProjectResponseSchema.parse(await created.json());
        projects.push(result.project.id);
        for (const suffix of ['', '?confirm=wrong'])
          expect((await request(actor.cookie, `/api/projects/${result.project.id}${suffix}`, 'DELETE')).status).toBe(422);
        await check(`/api/projects/${result.project.id}?confirm=${result.project.slug}`, 'DELETE', undefined, 204);
      } else await check(base, 'DELETE', undefined, 204);
      for (const body of [
        { name: 'Renamed fixture' },
        { description: 'Fictional' },
        { retentionDays: 180 },
        { retentionDays: 7, confirm: p.slug },
        { setupDismissed: true },
        { retentionReviewed: true },
      ])
        await check(base, 'PATCH', body, 200);
      if (!member) expect((await request(actor.cookie, base, 'PATCH', { retentionDays: 1 })).status).toBe(422);
      const keyResponse = await check(`${base}/keys`, 'POST', { name: 'Authz key', kind: 'read' }, 201);
      const existingKey = member ? await prisma.apiKey.findFirstOrThrow({ where: { projectId: p.id } }) : null;
      const keyId = existingKey ? existingKey.id : createApiKeyResponseSchema.parse(await keyResponse.json()).key.id;
      await check(`${base}/keys/${keyId}`, 'DELETE', undefined, 204);
      await check(`${base}/sample-data`, 'POST', undefined, 200);
      await check(`${base}/sample-data`, 'DELETE', undefined, 204);
      await check(`${base}/test-event`, 'POST', undefined, 202);
      const view = savedViewSchema.parse(
        await (await check(`${base}/views`, 'POST', { name: 'My view', description: null, state: {} }, 201, false)).json(),
      );
      await check(`${base}/views/${view.id}`, 'DELETE', undefined, 204, false);
      const otherView = await prisma.savedView.create({ data: { projectId: p.id, createdById: other.id, name: 'Other author', state: {} } });
      await check(`${base}/views/${otherView.id}`, 'DELETE', undefined, member ? 404 : 204, false);
      if (member) expect(await prisma.savedView.findUnique({ where: { id: otherView.id } })).not.toBeNull();
      const linkResponse = await check('/api/workspace/invite-links', 'POST', { role: 'member', expiresInDays: 1 }, 201);
      const linkId = member ? 'unknown' : ((await linkResponse.json()) as { id: string }).id;
      await check(`/api/workspace/invite-links/${linkId}`, 'DELETE', undefined, 204);
      for (const path of [base, `${base}/export?format=jsonl`, '/api/workspace/activity']) {
        const response = await request(actor.cookie, path);
        expect(response.status).toBe(200);
        await response.text();
      }
      // Every project mutation against another workspace must fail before disclosing or changing it.
      for (const [suffix, method, body] of [
        ['', 'PATCH', { name: 'Stolen' }],
        ['', 'DELETE', undefined],
        ['/keys', 'POST', { name: 'Stolen', kind: 'read' }],
        ['/keys/x', 'DELETE', undefined],
        ['/views', 'POST', { name: 'Stolen', description: null, state: {} }],
        ['/views/x', 'DELETE', undefined],
        ['/sample-data', 'POST', undefined],
        ['/sample-data', 'DELETE', undefined],
        ['/test-event', 'POST', undefined],
      ] as const) {
        const r = await request(actor.cookie, `/api/projects/${outsiderProject.id}${suffix}`, method, body);
        expect(r.status).toBe(404);
        expect(await r.text()).not.toContain('Private project');
      }
      expect((await request(actor.cookie, `/api/projects/${outsiderProject.id}`)).status).toBe(404);
      await prisma.session.updateMany({ where: { userId: actor.id }, data: { activeOrganizationId: outsiderOrg.id } });
      expect((await request(actor.cookie, `/api/projects/${outsiderProject.id}`, 'PATCH', { name: 'Stolen' })).status).toBe(403);
      expect((await request(actor.cookie, `/api/projects/${outsiderProject.id}`)).status).toBe(404);
      await prisma.session.updateMany({ where: { userId: actor.id }, data: { activeOrganizationId: organization.id } });
      expect((await request(actor.cookie, `${base}/future-mutation`, 'POST')).status).toBe(403);
      if (member) {
        expect(await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).toEqual(before);
        expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } })).revokedAt).toEqual(existingKey?.revokedAt);
        expect(
          (
            await request(actor.cookie, '/api/auth/organization/invite-member', 'POST', {
              organizationId: organization.id,
              email: 'nobody@example.test',
              role: 'admin',
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await request(actor.cookie, '/api/auth/organization/update-member-role', 'POST', {
              organizationId: organization.id,
              memberId: membership.id,
              role: 'owner',
            })
          ).status,
        ).toBe(403);
      }
    }
    expect((await prisma.project.findUniqueOrThrow({ where: { id: outsiderProject.id } })).name).toBe('Private project');
  } finally {
    for (const id of projects) await purgeProject(clickhouse, id);
    for (const id of orgs) {
      await purgeProject(clickhouse, `ws:${id}`);
      await prisma.organization.delete({ where: { id } });
    }
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
}, 900_000);
