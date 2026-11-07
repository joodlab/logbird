import { randomUUID } from 'node:crypto';
import { read } from '@logbird/clickhouse';
import { prisma, withProjectLock } from '@logbird/database';
import { expect, it } from 'vitest';
import { app } from './app';
import { clickhouse, purgeProjectEvents } from './clickhouse';
import { ingest } from './ingest';

it('DELETE project purges confirmed and unresolved receipts before returning 204 (real services)', async () => {
  const org = randomUUID();
  let userId = '',
    cookie = '',
    projectId = '';
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    const email = `immutable-delete-${randomUUID()}@example.test`;
    expect((await request('/api/auth/email-otp/send-verification-otp', 'POST', { email, type: 'sign-in' })).status).toBe(200);
    const mailbox = await (await fetch('http://127.0.0.1:8025/api/v1/messages?limit=100')).json();
    const message = mailbox.messages.find((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === email));
    const content = await (await fetch(`http://127.0.0.1:8025/api/v1/message/${message?.ID}`)).json();
    const login = await request('/api/auth/sign-in/email-otp', 'POST', { email, otp: content.Text.match(/\b\d{6}\b/)?.[0] });
    expect(login.status).toBe(200);
    userId = (await login.json()).user.id;
    cookie = login.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
    await prisma.organization.create({ data: { id: org, name: 'QA Immutable deletion', slug: org, createdAt: new Date() } });
    await prisma.member.create({ data: { id: randomUUID(), organizationId: org, userId, role: 'owner', createdAt: new Date() } });
    expect((await request('/api/auth/organization/set-active', 'POST', { organizationId: org })).status).toBe(200);
    const created = await request('/api/projects', 'POST', { name: 'QA Immutable deletion' });
    expect(created.status).toBe(201);
    const { project } = await created.json();
    projectId = project.id;
    await ingest(projectId, { id: 'delete-stored', action: 'delete.fixture', actor: { id: 'fictional' }, metadata: { fixture: true } });
    const now = new Date();
    await prisma.ingestReceipt.createMany({
      data: [null, now].map((confirmedAt, index) => ({
        projectId,
        organizationId: org,
        eventId: `delete-${index}`,
        fingerprint: 'fictional',
        receivedAt: now,
        eventAt: now,
        confirmedAt,
      })),
    });
    expect(await prisma.ingestReceipt.count({ where: { projectId } })).toBe(3);
    expect((await request(`/api/projects/${projectId}?confirm=${project.slug}`, 'DELETE')).status).toBe(204);
    expect(await prisma.ingestReceipt.count({ where: { projectId } })).toBe(0);
    expect(await prisma.project.count({ where: { id: projectId } })).toBe(0);
    for (const table of ['events', 'event_ids', 'events_by_minute', 'entities', 'attribute_keys'])
      expect((await read<{ n: number }>(clickhouse, `SELECT count() n FROM ${table} WHERE project_id={p:String}`, { p: projectId }))[0]?.n).toBe(0);
  } finally {
    if (projectId) await withProjectLock(projectId, () => purgeProjectEvents(projectId));
    await withProjectLock(`ws:${org}`, () => purgeProjectEvents(`ws:${org}`));
    await prisma.organization.deleteMany({ where: { id: org } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  }
}, 60_000);
