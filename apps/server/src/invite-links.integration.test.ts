import { randomUUID } from 'node:crypto';
import { purgeProject } from '@trailmark/clickhouse';
import * as s from '@trailmark/contracts';
import { prisma } from '@trailmark/database';
import { expect, it } from 'vitest';
import { app } from './app';
import { clickhouse } from './clickhouse';

it('real services: invite lifecycle, permissions, tenancy, atomic usage and persistent first completion', async () => {
  const users: string[] = [];
  let organizationId: string | undefined;
  let projectId: string | undefined;
  const request = (path: string, method = 'GET', body?: unknown, cookie = '') =>
    app.request(path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function login(email: string) {
    expect((await request('/api/auth/email-otp/send-verification-otp', 'POST', { email, type: 'sign-in' })).status).toBe(200);
    const mailbox = (await (await fetch('http://127.0.0.1:8025/api/v1/messages?limit=100')).json()) as {
      messages: { ID: string; To: { Address: string }[] }[];
    };
    const message = mailbox.messages.find((m) => m.To.some((t) => t.Address === email));
    const content = (await (await fetch(`http://127.0.0.1:8025/api/v1/message/${message?.ID}`)).json()) as { Text: string };
    const response = await request('/api/auth/sign-in/email-otp', 'POST', { email, otp: content.Text.match(/\b\d{6}\b/)?.[0] });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    if (email !== 'demo@trailmark.local') users.push(body.user.id);
    return {
      id: body.user.id,
      cookie: response.headers
        .getSetCookie()
        .map((v) => v.split(';')[0])
        .join('; '),
    };
  }
  const owner = await login(`links-${randomUUID()}@trailmark.local`);
  const joiners: { id: string; cookie: string }[] = [];
  try {
    for (let i = 0; i < 5; i++) joiners.push(await login(`join-${randomUUID()}@trailmark.local`));
    await login('demo@trailmark.local');
    const [first, second] = joiners;
    if (!first || !second) throw new Error('Missing join fixtures');
    const org = await request('/api/auth/organization/create', 'POST', { name: 'Invite fixture', slug: `invite-${randomUUID()}` }, owner.cookie);
    expect(org.status).toBe(200);
    organizationId = ((await org.json()) as { id: string }).id;
    await request('/api/auth/organization/set-active', 'POST', { organizationId }, owner.cookie);
    const base = '/api/workspace/invite-links';
    const create = async (input = {}) => {
      const r = await request(base, 'POST', input, owner.cookie);
      expect(r.status, await r.clone().text()).toBe(201);
      return s.inviteLinkSchema.parse(await r.json());
    };
    const token = (link: s.InviteLink) => new URL(link.url).pathname.slice('/join/'.length);
    const accept = (link: s.InviteLink, cookie: string) => request(`/api/invite-links/${token(link)}/accept`, 'POST', undefined, cookie);
    const link = await create({ maxUses: 1 });
    expect(token(link)).toMatch(/^[\w-]{32,}$/);
    const preview = await request(`/api/invite-links/${token(link)}`);
    expect(preview.headers.get('cache-control')).toBe('no-store');
    expect(s.inviteLinkPreviewSchema.parse(await preview.json()).state).toBe('active');
    expect((await accept(link, first.cookie)).status).toBe(200);
    expect(await prisma.member.findFirst({ where: { userId: first.id, organizationId } })).toMatchObject({ role: 'member' });
    expect(((await (await request('/api/me', 'GET', undefined, first.cookie)).json()) as { activeOrganizationId: string }).activeOrganizationId).toBe(
      organizationId,
    );
    expect((await prisma.inviteLink.findUniqueOrThrow({ where: { id: link.id } })).uses).toBe(1);
    const gone = await accept(link, second.cookie);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ error: { details: { state: 'exhausted' } } });
    const unlimited = await create();
    const duplicate = await accept(unlimited, first.cookie);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { details: { organizationId } } });
    expect((await request(base, 'POST', {}, first.cookie)).status).toBe(403);
    expect((await request(base, 'GET', undefined, first.cookie)).status).toBe(403);
    expect((await request(`${base}/${link.id}`, 'DELETE', undefined, first.cookie)).status).toBe(403);
    const restricted = await create({ allowedDomain: 'example.com' });
    expect((await accept(restricted, second.cookie)).status).toBe(403);
    expect((await request(`${base}/${unlimited.id}`, 'DELETE', undefined, owner.cookie)).status).toBe(204);
    expect((await accept(unlimited, second.cookie)).status).toBe(410);
    expect(s.inviteLinkPreviewSchema.parse(await (await request(`/api/invite-links/${token(unlimited)}`)).json()).state).toBe('revoked');
    const expired = await create();
    await prisma.inviteLink.update({ where: { id: expired.id }, data: { expiresAt: new Date(0) } });
    const expiry = await accept(expired, second.cookie);
    expect(expiry.status).toBe(410);
    expect(await expiry.json()).toMatchObject({ error: { details: { state: 'expired' } } });
    expect((await request('/api/invite-links/unknown')).status).toBe(404);
    expect((await request(base, 'POST', { role: 'owner' }, owner.cookie)).status).toBe(422);
    const raced = await create({ maxUses: 1, role: 'admin', allowedDomain: 'TRAILMARK.LOCAL' });
    const results = await Promise.all(joiners.slice(1).map((user) => accept(raced, user.cookie)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 410, 410, 410]);
    expect((await prisma.inviteLink.findUniqueOrThrow({ where: { id: raced.id } })).uses).toBe(1);
    const listed = s.inviteLinkListResponseSchema.parse(await (await request(base, 'GET', undefined, owner.cookie)).json());
    expect(listed.data.find((l) => l.id === raced.id)).toMatchObject({ state: 'exhausted', role: 'admin', uses: 1 });

    const created = s.createProjectResponseSchema.parse(
      await (await request('/api/projects', 'POST', { name: 'Completion fixture' }, owner.cookie)).json(),
    );
    projectId = created.project.id;
    const p = `/api/projects/${projectId}`;
    await request(`${p}/keys`, 'POST', { name: 'Read', kind: 'read' }, owner.cookie);
    await request(p, 'PATCH', { retentionReviewed: true }, owner.cookie);
    const ingest = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'fixture.created',
        occurredAt: new Date().toISOString(),
        actor: { id: 'fixture', type: 'user' },
        executor: { type: 'api' },
        tenant: { id: 'fixture' },
        targets: [{ type: 'fixture', id: '1' }],
        outcome: 'success',
        description: 'Fictional event',
        context: { operationId: 'fixture' },
      }),
    });
    expect(ingest.status).toBe(202);
    const statuses = await Promise.all(
      Array.from({ length: 3 }, async () => s.projectSetupSchema.parse(await (await request(`${p}/setup`, 'GET', undefined, owner.cookie)).json())),
    );
    const completedAt = statuses[0]?.completedAt;
    expect(completedAt).not.toBeNull();
    expect(statuses.every((v) => v.complete && v.completedAt === completedAt)).toBe(true);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).setupCompletedAt?.toISOString()).toBe(completedAt);
    await request(`${p}/keys/${created.ingestKey.key.id}`, 'DELETE', undefined, owner.cookie);
    const regressed = s.projectSetupSchema.parse(await (await request(`${p}/setup`, 'GET', undefined, owner.cookie)).json());
    expect(regressed.complete).toBe(false);
    expect(regressed.completedAt).toBe(completedAt);
    const summary = s.workspaceSetupSchema.parse(await (await request('/api/workspace/setup', 'GET', undefined, owner.cookie)).json());
    expect(summary.projects[0]?.completedAt).toBe(completedAt);
    const actions = await (
      await clickhouse.query({
        query: 'SELECT DISTINCT action FROM events WHERE project_id={p:String}',
        query_params: { p: `ws:${organizationId}` },
        format: 'JSONEachRow',
      })
    ).json<{ action: string }>();
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(['invite_link.created', 'invite_link.revoked', 'member.joined_via_link']),
    );
  } finally {
    if (projectId) await purgeProject(clickhouse, projectId);
    if (organizationId) {
      await purgeProject(clickhouse, `ws:${organizationId}`);
      await prisma.organization.delete({ where: { id: organizationId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
}, 120_000);
