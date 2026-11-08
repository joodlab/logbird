import { randomUUID } from 'node:crypto';
import { purgeProject } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { expect, it } from 'vitest';
import { app } from './app';
import { clickhouse } from './clickhouse';
import { drainTestAudit } from './test-audit';

it('accepted, rejected, canceled and resent invitations audit exactly once with actor/target', async () => {
  const users: string[] = [];
  let organizationId = '';
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
    const mailbox = (await (await fetch(`${process.env.MAILPIT_URL || 'http://127.0.0.1:8025'}/api/v1/messages?limit=100`)).json()) as {
      messages: { ID: string; To: { Address: string }[] }[];
    };
    const message = mailbox.messages.find((m) => m.To.some((t) => t.Address === email));
    const content = (await (await fetch(`${process.env.MAILPIT_URL || 'http://127.0.0.1:8025'}/api/v1/message/${message?.ID}`)).json()) as {
      Text: string;
    };
    const response = await request('', '/api/auth/sign-in/email-otp', 'POST', { email, otp: content.Text.match(/\b\d{6}\b/)?.[0] });
    expect(response.status).toBe(200);
    const { user } = (await response.json()) as { user: { id: string } };
    users.push(user.id);
    return {
      id: user.id,
      email,
      cookie: response.headers
        .getSetCookie()
        .map((v) => v.split(';')[0])
        .join('; '),
    };
  }

  try {
    const owner = await login(),
      accepted = await login(),
      rejected = await login();
    organizationId = randomUUID();
    await prisma.organization.create({
      data: { id: organizationId, name: 'Fictional invitation audit', slug: organizationId, createdAt: new Date() },
    });
    await prisma.member.create({ data: { id: randomUUID(), organizationId, userId: owner.id, role: 'owner', createdAt: new Date() } });
    await request(owner.cookie, '/api/auth/organization/set-active', 'POST', { organizationId });
    async function invite(email: string, resend = false) {
      const r = await request(owner.cookie, '/api/auth/organization/invite-member', 'POST', { organizationId, email, role: 'member', resend });
      expect(r.status).toBe(200);
      return (await r.json()) as { id: string };
    }
    const a = await invite(accepted.email),
      r = await invite(rejected.email),
      c = await invite(`cancel-${randomUUID()}@example.test`);
    expect((await request(accepted.cookie, '/api/auth/organization/accept-invitation', 'POST', { invitationId: a.id })).status).toBe(200);
    expect((await request(rejected.cookie, '/api/auth/organization/reject-invitation', 'POST', { invitationId: r.id })).status).toBe(200);
    await invite((await prisma.invitation.findUniqueOrThrow({ where: { id: c.id } })).email, true);
    expect((await request(owner.cookie, '/api/auth/organization/cancel-invitation', 'POST', { invitationId: c.id })).status).toBe(200);
    await drainTestAudit(organizationId);
    const rows = await (
      await clickhouse.query({
        query: 'SELECT action,actor_id,target_ids,target_names FROM events WHERE project_id={p:String}',
        query_params: { p: `ws:${organizationId}` },
        format: 'JSONEachRow',
      })
    ).json<{ action: string; actor_id: string; target_ids: string[]; target_names: string[] }>();
    for (const [verb, actor, target] of [
      ['accepted', accepted.id, a.id],
      ['rejected', rejected.id, r.id],
      ['canceled', owner.id, c.id],
      ['resent', owner.id, c.id],
    ]) {
      const matches = rows.filter((row) => row.action === `member.invitation.${verb}`);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.actor_id).toBe(actor);
      expect(matches[0]?.target_ids).toEqual([target]);
      expect(matches[0]?.target_names[0]).toContain('@example.test');
    }
    const p = await prisma.project.create({ data: { organizationId, name: 'Original', slug: randomUUID() } });
    const view = await prisma.savedView.create({ data: { projectId: p.id, name: 'Named view', state: {}, createdById: owner.id } });
    expect((await request(owner.cookie, `/api/projects/${p.id}/views/${view.id}`, 'DELETE')).status).toBe(204);
    expect((await request(owner.cookie, `/api/projects/${p.id}`, 'PATCH', { name: 'Renamed' })).status).toBe(200);
    expect(await prisma.retentionRun.count({ where: { projectId: p.id } })).toBe(0);
    expect((await request(owner.cookie, `/api/projects/${p.id}`, 'PATCH', { retentionDays: 180 })).status).toBe(200);
    expect(await prisma.retentionRun.count({ where: { projectId: p.id } })).toBe(0);
    await prisma.user.update({ where: { id: owner.id }, data: { name: '' } });
    const createdKey = await request(owner.cookie, `/api/projects/${p.id}/keys`, 'POST', { name: 'Creator fallback', kind: 'read' });
    expect(createdKey.status).toBe(201);
    const created = await createdKey.json();
    expect(created.key.createdBy.name).toBe(owner.email);
    expect(created.key.createdBy.email).toBe(owner.email);
    await drainTestAudit(organizationId);
    const activity = await (await request(owner.cookie, '/api/workspace/activity')).json();
    expect(activity.data.find((e: { action: string }) => e.action === 'saved_view.deleted').targets[0].name).toBe('Named view');
    expect(
      activity.data.find(
        (e: { action: string; changes: { field: string }[] }) =>
          e.action === 'project.updated' && e.changes.some((change) => change.field === 'name'),
      ).changes,
    ).toEqual([{ field: 'name', before: 'Original', after: 'Renamed' }]);
    console.log(
      'four lifecycle actions exactly once, correct actors/targets; view name and project before/after verified; retention increase creates no purge run',
    );
  } finally {
    if (organizationId) {
      await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${organizationId}` } });
      await purgeProject(clickhouse, `ws:${organizationId}`);
      await prisma.organization.delete({ where: { id: organizationId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
}, 120_000);
