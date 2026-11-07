import { randomUUID } from 'node:crypto';
import { purgeProject } from '@logbird/clickhouse';
import { createProjectResponseSchema, WORKSPACE_ACTIVITY_CATEGORIES } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { expect, it } from 'vitest';
import { app } from './app';
import { clickhouse } from './clickhouse';

it('SECURITY-05/06/08/10 and OWNER-12: real auth, key, rename, retention and chip evidence', async () => {
  const users: string[] = [];
  let organizationId = '';
  let project: { id: string; slug: string } | undefined;
  let ownerCookie = '';
  const emailPeers = new Map<string, string>();
  const cookiePeers = new Map<string, string>();
  const emailPeer = (email: string) => {
    if (!emailPeers.has(email)) emailPeers.set(email, `203.0.113.${80 + emailPeers.size}`);
    return emailPeers.get(email) ?? '';
  };
  const request = (cookie: string, path: string, method = 'GET', body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { cookie, 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      {
        incoming: {
          socket: {
            remoteAddress:
              cookiePeers.get(cookie) ??
              (body && typeof body === 'object' && 'email' in body && typeof body.email === 'string' ? emailPeer(body.email) : '203.0.113.74'),
          },
        },
      },
    );
  async function challenge(email: string) {
    expect((await request('', '/api/auth/email-otp/send-verification-otp', 'POST', { email, type: 'sign-in' })).status).toBe(200);
    const mailbox = await (await fetch(`http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=5`)).json();
    const content = await (await fetch(`http://127.0.0.1:8025/api/v1/message/${mailbox.messages[0].ID}`)).json();
    return content.Text.match(/\b\d{6}\b/)[0] as string;
  }
  async function login(email = `qa-fix-ownaudit-${randomUUID()}@example.test`) {
    const response = await request('', '/api/auth/sign-in/email-otp', 'POST', { email, otp: await challenge(email) });
    expect(response.status).toBe(200);
    const { user } = await response.json();
    if (!users.includes(user.id)) users.push(user.id);
    const cookie = response.headers
      .getSetCookie()
      .map((s) => s.split(';')[0])
      .join('; ');
    const ip = emailPeer(email);
    cookiePeers.set(cookie, ip);
    return { id: user.id as string, email, cookie, ip };
  }
  const rawActivity = async () =>
    (
      await clickhouse.query({
        query: 'SELECT payload FROM events WHERE project_id={p:String} ORDER BY timestamp,event_id',
        query_params: { p: `ws:${organizationId}` },
        format: 'JSONEachRow',
      })
    )
      .json<{ payload: string }>()
      .then((rows) => rows.map((r) => JSON.parse(r.payload)));
  try {
    const owner = await login();
    ownerCookie = owner.cookie;
    const org = await request(owner.cookie, '/api/auth/organization/create', 'POST', {
      name: 'QA Fix own audit',
      slug: `qa-fix-ownaudit-${randomUUID()}`,
    });
    expect(org.status).toBe(200);
    organizationId = (await org.json()).id;
    const actors = [owner];
    await request(owner.cookie, '/api/auth/organization/set-active', 'POST', { organizationId });
    for (const role of ['admin', 'member']) {
      const user = await login();
      const invitation = await request(owner.cookie, '/api/auth/organization/invite-member', 'POST', { organizationId, email: user.email, role });
      expect(invitation.status).toBe(200);
      expect(
        (await request(user.cookie, '/api/auth/organization/accept-invitation', 'POST', { invitationId: (await invitation.json()).id })).status,
      ).toBe(200);
      await request(user.cookie, '/api/auth/organization/set-active', 'POST', { organizationId });
      actors.push(user);
    }
    const admin = actors[1];
    const member = actors[2];
    if (!admin || !member) throw new Error('Role fixture missing');
    const created = await request(owner.cookie, '/api/projects', 'POST', { name: 'QA Fix own audit project', retentionDays: 30 });
    expect(created.status).toBe(201);
    const initial = createProjectResponseSchema.parse(await created.json());
    project = initial.project;
    const path = `/api/projects/${project.id}`;
    const keys = [initial.ingestKey.key];
    for (const actor of [owner, admin]) {
      for (const kind of ['read', 'ingest']) {
        const createdKey = await request(actor.cookie, `${path}/keys`, 'POST', { name: `QA ${kind} evidence`, kind });
        expect(createdKey.status).toBe(201);
        const key = (await createdKey.json()).key;
        keys.push(key);
        expect((await request(actor.cookie, `${path}/keys/${key.id}`, 'DELETE')).status).toBe(204);
        expect((await request(actor.cookie, `${path}/keys/${key.id}`, 'DELETE')).status).toBe(204);
      }
    }
    expect((await request(member.cookie, `${path}/keys`, 'POST', { name: 'Denied key', kind: 'read' })).status).toBe(403);
    expect((await request(member.cookie, `${path}/keys/${initial.ingestKey.key.id}`, 'DELETE')).status).toBe(403);

    for (const [actor, before, after] of [
      [owner, 'QA Fix own audit', 'QA Fix own audit renamed'],
      [admin, 'QA Fix own audit renamed', 'QA Fix own audit'],
    ] as const) {
      const renamed = await request(actor.cookie, '/api/auth/organization/update', 'POST', { organizationId, data: { name: after } });
      expect(renamed.status).toBe(200);
      const receipt = (await rawActivity()).find((r) => r.context?.requestId === renamed.headers.get('x-request-id'));
      expect(receipt).toMatchObject({
        action: 'organization.updated',
        actor: { id: actor.id },
        changes: [{ field: 'name', before, after }],
        context: { ip: actor.ip },
      });
    }
    expect((await request(member.cookie, '/api/auth/organization/update', 'POST', { organizationId, data: { name: 'Denied rename' } })).status).toBe(
      403,
    );
    const noOp = await request(owner.cookie, '/api/auth/organization/update', 'POST', { organizationId, data: { name: 'QA Fix own audit' } });
    expect(noOp.status).toBe(200);
    expect((await rawActivity()).filter((r) => r.context?.requestId === noOp.headers.get('x-request-id'))).toHaveLength(0);

    const raised = await request(owner.cookie, path, 'PATCH', { retentionDays: 90 });
    expect(raised.status).toBe(200);
    const raisedRows = (await rawActivity()).filter((r) => r.context?.requestId === raised.headers.get('x-request-id'));
    expect(raisedRows.map((r) => r.action)).toEqual(['project.retention.changed']);
    expect(raisedRows[0].changes).toEqual([{ field: 'retentionDays', before: 30, after: 90 }]);
    const mixed = await request(admin.cookie, path, 'PATCH', { name: 'QA Fix own audit renamed project', retentionDays: 180 });
    expect(mixed.status).toBe(200);
    const mixedRows = (await rawActivity()).filter((r) => r.context?.requestId === mixed.headers.get('x-request-id'));
    expect(mixedRows.map((r) => r.action).sort()).toEqual(['project.retention.changed', 'project.updated']);
    expect(mixedRows.find((r) => r.action === 'project.updated').changes.map((change: { field: string }) => change.field)).toEqual(['name']);
    expect((await request(member.cookie, path, 'PATCH', { retentionDays: 365 })).status).toBe(403);
    expect(await prisma.retentionRun.count({ where: { projectId: project.id } })).toBe(0);
    expect(
      (
        await request(member.cookie, `${path}/views`, 'POST', {
          name: 'QA evidence view',
          description: null,
          state: { q: '', range: '24h', columns: ['time', 'action'] },
        })
      ).status,
    ).toBe(201);
    expect((await request(owner.cookie, '/api/workspace/invite-links', 'POST', { role: 'member', maxUses: 1, expiresInDays: 7 })).status).toBe(201);

    for (const actor of actors) {
      const otp = await challenge(actor.email);
      const wrong = otp === '000000' ? '111111' : '000000';
      for (let i = 0; i < 7; i++) {
        const failed = await request('', '/api/auth/sign-in/email-otp', 'POST', { email: actor.email, otp: wrong });
        expect([400, 403]).toContain(failed.status);
        expect(await failed.json()).not.toHaveProperty('user');
      }
      const signedOut = await request(actor.cookie, '/api/auth/sign-out', 'POST', {});
      expect(signedOut.status).toBe(200);
      expect((await request(actor.cookie, '/api/me')).status).toBe(401);
      expect((await request(actor.cookie, '/api/auth/sign-out', 'POST', {})).status).toBe(200);
      const rows = await rawActivity();
      const logoutRows = rows.filter((r) => r.action === 'auth.signed_out' && r.actor.id === actor.id);
      expect(logoutRows).toHaveLength(1);
      expect(logoutRows[0]).toMatchObject({
        targets: [{ type: 'session' }],
        context: { ip: actor.ip, requestId: signedOut.headers.get('x-request-id') },
      });
      expect(JSON.stringify(logoutRows)).not.toContain('token');
      const next = await login(actor.email);
      actor.cookie = next.cookie;
      if (actor.id === owner.id) ownerCookie = next.cookie;
      await request(actor.cookie, '/api/auth/organization/set-active', 'POST', { organizationId });
      expect((await rawActivity()).filter((r) => r.action === 'auth.signed_in' && r.actor.id === actor.id)).toHaveLength(1);
    }
    const rows = await rawActivity();
    const failures = rows.filter((r) => r.action === 'auth.sign_in.failed');
    expect(failures).toHaveLength(6); // one invalid-code and one lockout record per account, despite seven attempts
    expect(failures.filter((r) => r.metadata.reason === 'locked_out')).toHaveLength(3);
    for (const row of failures) {
      expect(row.actor.type).toBe('anonymous');
      expect(row.metadata.emailHash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.context.ip).toMatch(/^203\.0\.113\.8[0-2]$/);
      expect(JSON.stringify(row)).not.toContain('@example.test');
      expect(JSON.stringify(row)).not.toContain('000000');
    }
    // Delete only the owned fictional project, then reconstruct all key evidence from the surviving workspace stream.
    expect((await request(owner.cookie, `${path}?confirm=${project.slug}`, 'DELETE')).status).toBe(204);
    project = undefined;
    const afterDeletion = await rawActivity();
    for (const key of keys) {
      const lifecycle = afterDeletion.filter((r) => r.targets?.[0]?.id === key.id && r.action.startsWith('api_key.'));
      expect(lifecycle).toHaveLength(key.id === initial.ingestKey.key.id ? 1 : 2);
      for (const row of lifecycle) {
        expect(row.targets[1]).toMatchObject({ type: 'project', id: initial.project.id });
        expect(row.metadata.apiKey).toMatchObject({
          kind: key.kind,
          prefix: key.prefix,
          scope: key.kind === 'read' ? 'events:read' : 'events:ingest',
        });
        expect(JSON.stringify(row)).not.toContain(initial.ingestKey.secret);
        expect(JSON.stringify(row)).not.toContain('"hash"');
      }
    }
    for (const actor of actors) {
      for (const [category] of WORKSPACE_ACTIVITY_CATEGORIES) {
        const response = await request(actor.cookie, `/api/workspace/activity?limit=200&q=category:${category}`);
        expect(response.status).toBe(200);
        const { data } = await response.json();
        expect(data.length).toBeGreaterThan(0);
        expect(data.every((event: { category: string }) => event.category === category)).toBe(true);
      }
    }
    console.log(
      'SECURITY own-audit: owner/admin/member failed OTP + lockout rate limit, actual sign-out/replay and successful sign-in; owner/admin rename before/after; read/ingest/initial key evidence survives project deletion; retention-only single receipt and disjoint mixed receipt; all seven activity categories verified for all roles.',
    );
  } finally {
    if (project) await request(ownerCookie, `/api/projects/${project.id}?confirm=${project.slug}`, 'DELETE');
    if (organizationId) {
      await purgeProject(clickhouse, `ws:${organizationId}`);
      await prisma.organization.delete({ where: { id: organizationId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
}, 120_000);
