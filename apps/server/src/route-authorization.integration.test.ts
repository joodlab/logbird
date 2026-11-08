import { randomUUID } from 'node:crypto';
import { purgeProject } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import { app } from './app';
import { clickhouse } from './clickhouse';
import { ingest } from './ingest';
import { generateApiKey } from './keys';
import { consoleMatrix } from './route-authorization.matrix';

// This suite tests authorization; rate limits have their own real-Redis suite.
// The per-file queue/rate namespace is isolated by test-services.ts.
vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_PER_MINUTE = '10000';
  process.env.PUBLIC_RATE_LIMIT_PER_MINUTE = '10000';
});

it('denies anonymous and foreign-project requests through every concrete route; confines read/ingest keys', async () => {
  const users: string[] = [];
  const organizations: string[] = [];
  const projects: string[] = [];
  const marker = `foreign-${randomUUID()}`;
  const eventId = `shared-id-${randomUUID()}`;
  const request = (path: string, method = 'GET', cookie = '', body?: unknown, key?: string) =>
    app.request(path, {
      method,
      headers: {
        cookie,
        Origin: process.env.APP_URL ?? 'http://localhost:4600',
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function login() {
    const email = `matrix-${randomUUID()}@example.test`;
    expect((await request('/api/auth/email-otp/send-verification-otp', 'POST', '', { email, type: 'sign-in' })).status).toBe(200);
    const mailbox = await (await fetch(`${process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025'}/api/v1/messages?limit=100`)).json();
    const message = mailbox.messages.find((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === email));
    expect(message).toBeTruthy();
    const content = await (await fetch(`${process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025'}/api/v1/message/${message.ID}`)).json();
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
  try {
    const actor = await login();
    for (const name of ['QA Matrix allowed', 'QA Matrix foreign']) {
      const org = await prisma.organization.create({ data: { id: randomUUID(), name, slug: randomUUID(), createdAt: new Date() } });
      organizations.push(org.id);
      const project = await prisma.project.create({ data: { organizationId: org.id, name, slug: randomUUID() } });
      projects.push(project.id);
    }
    const [allowed, foreign] = projects;
    const [allowedOrganization, foreignOrganization] = organizations;
    if (!allowed || !foreign || !allowedOrganization || !foreignOrganization) throw new Error('Matrix fixtures were not created');
    const membership = await prisma.member.create({
      data: { id: randomUUID(), userId: actor.id, organizationId: allowedOrganization, role: 'owner', createdAt: new Date() },
    });
    await prisma.session.updateMany({ where: { userId: actor.id }, data: { activeOrganizationId: allowedOrganization } });
    for (const [index, project] of projects.entries()) {
      await ingest(project, {
        id: eventId,
        action: index ? marker : 'allowed.event',
        actor: { id: 'shared-actor', name: index ? marker : 'Allowed' },
        tenant: { id: 'shared-tenant' },
        targets: [{ type: 'record', id: 'shared-record' }],
        context: { operationId: 'shared-operation' },
        metadata: { isolation: index ? marker : 'allowed' },
      });
    }
    const range = { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
    const pathFor = (pattern: string, project: string) => {
      const path = pattern
        .replace(':projectId', project)
        .replace(':eventId', eventId)
        .replace(':operationId', 'shared-operation')
        .replace(':kind', 'actor')
        .replace(':entityId', 'shared-actor')
        .replace(/:(?:keyId|viewId|linkId|invitationId|token)/g, 'unknown');
      return `${path}?${new URLSearchParams({ ...range, since: range.from, field: 'action', kind: 'actor', format: 'jsonl' })}`;
    };
    for (const [method, pattern, policy] of consoleMatrix) {
      const anonymous = await request(pathFor(pattern, allowed), method, '', method === 'GET' || method === 'DELETE' ? undefined : {});
      expect(anonymous.status, `anonymous ${method} ${pattern}`).toBe(policy === 'invitation-secret' ? 404 : 401);
      await anonymous.text();
      if (!pattern.includes(':projectId')) continue;
      const response = await request(pathFor(pattern, foreign), method, actor.cookie, method === 'GET' || method === 'DELETE' ? undefined : {});
      expect(response.status, `foreign ${method} ${pattern}`).toBe(404);
      expect(await response.text()).not.toContain(marker);
      if (method !== 'GET') continue;
      const own = await request(pathFor(pattern, allowed), method, actor.cookie);
      expect(own.status, `own ${method} ${pattern}`).toBe(200);
      expect(await own.text()).not.toContain(marker);
    }
    // A stale/forged active workspace must never turn into membership.
    await prisma.session.updateMany({ where: { userId: actor.id }, data: { activeOrganizationId: foreignOrganization } });
    for (const [method, pattern] of consoleMatrix.filter(([method, path]) => method === 'GET' && path.includes(':projectId'))) {
      const response = await request(pathFor(pattern, foreign), method, actor.cookie);
      expect(response.status, `missing membership ${pattern}`).toBe(404);
      await response.text();
    }
    await prisma.session.updateMany({ where: { userId: actor.id }, data: { activeOrganizationId: allowedOrganization } });
    await prisma.member.update({ where: { id: membership.id }, data: { role: 'member' } });
    for (const [method, pattern] of consoleMatrix.filter(([, , policy]) => policy === 'admin')) {
      const response = await request(pathFor(pattern, allowed), method, actor.cookie, method === 'GET' || method === 'DELETE' ? undefined : {});
      expect(response.status, `member ${method} ${pattern}`).toBe(403);
      await response.text();
    }
    const ingestKey = generateApiKey('ingest');
    const readKey = generateApiKey('read');
    for (const [kind, key] of [
      ['ingest', ingestKey],
      ['read', readKey],
    ] as const) {
      await prisma.apiKey.create({ data: { projectId: allowed, name: 'QA matrix', kind, hash: key.hash, prefix: key.prefix } });
    }
    for (const [method, pattern] of consoleMatrix.filter(([, path]) => path.startsWith('/v1/'))) {
      const wrong = await request(
        pathFor(pattern, allowed),
        method,
        '',
        method === 'POST' ? { action: 'key.scope' } : undefined,
        method === 'POST' ? readKey.secret : ingestKey.secret,
      );
      expect(wrong.status, `wrong key ${method} ${pattern}`).toBe(401);
      await wrong.text();
      const own = await request(
        `${pathFor(pattern, foreign)}&projectId=${foreign}&project_id=${foreign}`,
        method,
        '',
        method === 'POST' ? { action: 'key.scope', projectId: foreign, project_id: foreign } : undefined,
        method === 'POST' ? ingestKey.secret : readKey.secret,
      );
      expect(own.status).toBe(method === 'POST' ? 202 : 200);
      expect(await own.text()).not.toContain(marker);
      const sql = await request(
        `${pathFor(pattern, allowed)}&lang=sql&q=1`,
        method,
        '',
        method === 'POST' ? { action: 'key.scope' } : undefined,
        method === 'POST' ? ingestKey.secret : readKey.secret,
      );
      expect(sql.status).toBe(422);
      await sql.text();
    }
    const foreignRows = await (
      await clickhouse.query({
        query: 'SELECT action FROM events WHERE project_id={p:String}',
        query_params: { p: foreign },
        format: 'JSONEachRow',
      })
    ).json<{ action: string }>();
    expect(foreignRows).toEqual([{ action: marker }]);
    console.log(
      `Cloud matrix: ${consoleMatrix.length} concrete routes; anonymous, cross-project, membership, role and key-scope assertions completed against real services.`,
    );
  } finally {
    for (const project of projects) await purgeProject(clickhouse, project);
    for (const organization of organizations) {
      await purgeProject(clickhouse, `ws:${organization}`);
      await prisma.organization.deleteMany({ where: { id: organization } });
    }
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    for (const table of ['events', 'events_by_minute', 'entities', 'attribute_keys', 'event_ids']) {
      const remaining = await (
        await clickhouse.query({
          query: `SELECT count() AS n FROM ${table} WHERE project_id IN {projects:Array(String)}`,
          query_params: { projects: [...projects, ...organizations.map((id) => `ws:${id}`)] },
          format: 'JSONEachRow',
        })
      ).json<{ n: number }>();
      expect(Number(remaining[0]?.n), `fixture cleanup ${table}`).toBe(0);
    }
  }
}, 180_000);
