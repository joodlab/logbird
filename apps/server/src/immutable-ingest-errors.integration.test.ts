import { randomUUID } from 'node:crypto';
import { insertEvents, normalizeEvent, read } from '@logbird/clickhouse';
import { prisma, withProjectLock } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import { app } from './app';
import { clickhouse, purgeProjectEvents } from './clickhouse';
import { generateApiKey } from './keys';

it('returns 422 and releases claims for parse failures; ambiguous errors retain claims and retry after visibility', async () => {
  const org = randomUUID(),
    project = `immutable-errors-${randomUUID()}`;
  const key = generateApiKey('ingest');
  await prisma.organization.create({ data: { id: org, name: 'QA Immutable errors', slug: org, createdAt: new Date() } });
  await prisma.project.create({ data: { id: project, organizationId: org, name: 'QA Immutable errors', slug: project } });
  await prisma.apiKey.create({ data: { projectId: project, name: 'QA key', kind: 'ingest', hash: key.hash, prefix: key.prefix } });
  const post = (event: unknown) =>
    app.request('/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.secret}` },
      body: JSON.stringify(event),
    });
  const spy = vi.spyOn(clickhouse, 'insert');
  try {
    for (const code of ['6', '27', '38', '41', '53', '69', '72']) {
      spy.mockRejectedValueOnce(Object.assign(new Error('fictional parse failure'), { code }));
      const response = await post({ id: `parse-${code}`, action: 'parse.original' });
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe('invalid_event');
      expect(await prisma.ingestReceipt.count({ where: { projectId: project } })).toBe(0);
    }
    // Actual ClickHouse parsing failure at the storage boundary, after the normalized claim is created.
    spy.mockRestore();
    const insert = clickhouse.insert.bind(clickhouse);
    const realParseSpy = vi.spyOn(clickhouse, 'insert').mockImplementationOnce(() =>
      insert({
        table: 'events',
        values: [
          {
            project_id: project,
            event_id: 'real-parse',
            action: 'parse.original',
            timestamp: new Date().toISOString(),
            job_attempt: 'not-an-integer',
          },
        ],
        format: 'JSONEachRow',
        clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
      }),
    );
    try {
      expect((await post({ id: 'real-parse', action: 'parse.original' })).status).toBe(422);
      expect(await prisma.ingestReceipt.count({ where: { projectId: project } })).toBe(0);
      expect((await read<{ n: number }>(clickhouse, 'SELECT count() n FROM events WHERE project_id={p:String}', { p: project }))[0]?.n).toBe(0);
    } finally {
      realParseSpy.mockRestore();
    }
    expect((await post({ id: 'real-parse', action: 'parse.original' })).status).toBe(202);

    const event = { id: 'uncertain', action: 'uncertain.original', occurredAt: new Date().toISOString() };
    const uncertain = vi.spyOn(clickhouse, 'insert').mockRejectedValueOnce(new Error('connection reset'));
    try {
      const failed = await post(event);
      expect(failed.status).toBe(503);
      expect(failed.headers.get('Retry-After')).toBe('1');
      expect((await failed.json()).error.code).toBe('ingest_pending');
    } finally {
      uncertain.mockRestore();
    }
    expect((await post(event)).status).toBe(503);
    expect(await prisma.ingestReceipt.count({ where: { projectId: project, eventId: event.id, confirmedAt: null } })).toBe(1);
    // Simulate the original delayed INSERT becoming visible, then retry the same HTTP request.
    const receipt = await prisma.ingestReceipt.findUniqueOrThrow({ where: { projectId_eventId: { projectId: project, eventId: event.id } } });
    const normalized = normalizeEvent(event, { projectId: project, receivedAt: receipt.receivedAt });
    if (!normalized.ok) throw new Error('Invalid fixture');
    await insertEvents(clickhouse, [normalized.row]);
    const recovered = await post(event);
    expect(recovered.status).toBe(202);
    expect((await recovered.json()).ids).toEqual([event.id]);
    expect(await prisma.ingestReceipt.count({ where: { projectId: project, eventId: event.id, confirmedAt: null } })).toBe(0);
  } finally {
    spy.mockRestore();
    await withProjectLock(project, () => purgeProjectEvents(project));
    await prisma.organization.delete({ where: { id: org } });
  }
}, 60_000);

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
    expect(await prisma.ingestReceipt.count({ where: { projectId } })).toBe(2);
    expect((await request(`/api/projects/${projectId}?confirm=${project.slug}`, 'DELETE')).status).toBe(204);
    expect(await prisma.ingestReceipt.count({ where: { projectId } })).toBe(0);
    expect(await prisma.project.count({ where: { id: projectId } })).toBe(0);
  } finally {
    if (projectId) await withProjectLock(projectId, () => purgeProjectEvents(projectId));
    await withProjectLock(`ws:${org}`, () => purgeProjectEvents(`ws:${org}`));
    await prisma.organization.deleteMany({ where: { id: org } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
  }
}, 60_000);
