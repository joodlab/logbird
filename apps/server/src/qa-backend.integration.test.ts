import { randomUUID } from 'node:crypto';
import { purgeProject } from '@trailmark/clickhouse';
import { prisma } from '@trailmark/database';
import { Trailmark } from '@trailmark/sdk';
import { expect, it } from 'vitest';
import { app } from './app';
import { clickhouse } from './clickhouse';

it('QA backend: invalid views, coherent sample data, named audit targets, SQL guidance and OpenAPI examples (real services)', async () => {
  const users: string[] = [];
  const request = (cookie: string, path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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

  const orgId = randomUUID();
  let projectId: string | undefined;
  try {
    const owner = await login();
    await prisma.organization.create({ data: { id: orgId, name: 'QA Backend fictional', slug: orgId, createdAt: new Date() } });
    await prisma.member.create({ data: { id: randomUUID(), organizationId: orgId, userId: owner.id, role: 'owner', createdAt: new Date() } });
    expect((await request(owner.cookie, '/api/auth/organization/set-active', 'POST', { organizationId: orgId })).status).toBe(200);
    const created = await request(owner.cookie, '/api/projects', 'POST', { name: 'QA Backend fictional' });
    expect(created.status).toBe(201);
    const project = await created.json();
    projectId = project.project.id;
    const path = `/api/projects/${projectId}`;
    for (const [lang, q] of [
      ['query', 'attempt:>abc'],
      ['sql', 'SELECT * FROM events'],
      ['sql', 'unknown_column = 1'],
    ]) {
      const response = await request(owner.cookie, `${path}/views`, 'POST', { name: 'Invalid fixture', description: null, state: { lang, q } });
      expect(response.status).toBe(422);
      expect((await response.json()).error).toMatchObject({ code: 'invalid_query', details: { lang } });
    }
    for (const [lang, q] of [
      ['query', 'outcome:failure'],
      ['sql', "outcome = 'failure'"],
    ]) {
      const response = await request(owner.cookie, `${path}/views`, 'POST', { name: 'Valid fixture', description: null, state: { lang, q } });
      expect(response.status).toBe(201);
      expect((await response.json()).state).toEqual({ lang, q });
    }
    expect((await (await request(owner.cookie, `${path}/views`)).json()).data).toHaveLength(2);
    for (const q of ["SELECT * FROM events WHERE outcome='failure'", 'WITH 1 AS x SELECT x']) {
      const response = await request(owner.cookie, `${path}/events?${new URLSearchParams({ lang: 'sql', q })}`);
      expect(response.status).toBe(422);
      expect((await response.json()).error.message).toBe("Enter only a WHERE expression (e.g. outcome = 'failure')");
    }
    const subquery = await request(
      owner.cookie,
      `${path}/events?${new URLSearchParams({ lang: 'sql', q: 'event_id IN (SELECT event_id FROM events)' })}`,
    );
    expect(subquery.status).toBe(422);
    expect((await subquery.json()).error.message).toBe('Subqueries are not allowed');
    expect((await request(owner.cookie, `${path}/sample-data`, 'POST')).status).toBe(200);
    const rows = await (
      await clickhouse.query({
        query:
          'SELECT operation_id, tenant_id, actor_id, action, target_types, changes_after, job_attempt FROM events WHERE project_id={p:String} ORDER BY timestamp',
        query_params: { p: projectId },
        format: 'JSONEachRow',
      })
    ).json<{
      operation_id: string;
      tenant_id: string;
      actor_id: string;
      action: string;
      target_types: string[];
      changes_after: string[];
      job_attempt: number;
    }>();
    expect(rows).toHaveLength(2000);
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = groups.get(row.operation_id) ?? [];
      group.push(row);
      groups.set(row.operation_id, group);
    }
    expect(groups.size).toBe(400);
    for (const story of groups.values()) {
      expect(new Set(story.map((row) => row.tenant_id)).size).toBe(1);
      expect(new Set(story.map((row) => row.actor_id)).size).toBe(1);
      expect(story.slice(0, 4).map((row) => row.action)).toEqual([
        'reservation.created',
        'reservation.confirmed',
        'invoice.issued',
        'payment.processed',
      ]);
      if (story[4]?.action === 'room.updated') expect(story[4].target_types).toEqual(['room']);
      else {
        expect(story[4]?.job_attempt).toBe(2);
        expect(story[4]?.changes_after).toEqual(['paid']);
      }
    }
    const records = await (
      await clickhouse.query({
        query:
          'SELECT target_id, uniqExact(tenant_id) AS tenants FROM events ARRAY JOIN target_ids AS target_id WHERE project_id={p:String} GROUP BY target_id',
        query_params: { p: projectId },
        format: 'JSONEachRow',
      })
    ).json<{ tenants: number }>();
    expect(records.every((record) => Number(record.tenants) === 1)).toBe(true);
    const key = await (await request(owner.cookie, `${path}/keys`, 'POST', { name: 'QA named read', kind: 'read' })).json();
    expect((await request(owner.cookie, `${path}/keys/${key.key.id}`, 'DELETE')).status).toBe(204);
    const linkResponse = await request(owner.cookie, '/api/workspace/invite-links', 'POST', { role: 'member', expiresInDays: 7, maxUses: 1 });
    expect(linkResponse.status).toBe(201);
    const link = await linkResponse.json();
    const joiner = await login();
    expect((await request(joiner.cookie, `/api/invite-links/${link.url.split('/').at(-1)}/accept`, 'POST')).status).toBe(200);
    expect((await request(owner.cookie, `/api/workspace/invite-links/${link.id}`, 'DELETE')).status).toBe(204);
    const activity = await (await request(owner.cookie, '/api/workspace/activity?limit=200')).json();
    expect(activity.data.find((e: { action: string }) => e.action === 'member.joined_via_link').actor.name).toContain('@example.test');
    for (const action of ['api_key.created', 'api_key.revoked'])
      expect(
        activity.data.find((e: { action: string; targets: { name: string }[] }) => e.action === action && e.targets[0]?.name === 'QA named read'),
      ).toBeTruthy();
    for (const action of ['invite_link.created', 'invite_link.revoked'])
      expect(activity.data.find((e: { action: string }) => e.action === action).targets[0].name).toBe('member');
    const spec = await (await request('', '/openapi.json')).json();
    expect(spec.servers[0].url).toBe(process.env.APP_URL);
    const example = spec.paths['/v1/events'].post.requestBody.content['application/json'].example;
    expect(example).toEqual({ action: 'document.updated' });
    const ingest = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${project.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(example),
    });
    expect(ingest.status).toBe(202);
    console.log('T10/T12/T13/T16/T19: real Postgres/ClickHouse/Dragonfly/Mailpit acceptance passed');
  } finally {
    if (projectId) {
      await purgeProject(clickhouse, projectId);
      await prisma.project.deleteMany({ where: { id: projectId } });
    }
    await purgeProject(clickhouse, `ws:${orgId}`);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
}, 180_000);

it('T4 bounds the queue with a real dead endpoint', async () => {
  const sdk = new Trailmark({ apiKey: 'fictional', endpoint: 'http://127.0.0.1:4875', maxRetries: 0, maxQueueSize: 10, batchSize: 1000 });
  for (let i = 0; i < 5000; i++) sdk.track({ action: 'outage.fixture' });
  expect(sdk.queueSize).toBe(10);
  expect(sdk.dropped).toBe(4990);
  await expect(sdk.flush()).rejects.toThrow();
  expect(sdk.queueSize).toBe(10);
  await expect(sdk.shutdown()).rejects.toThrow();
  console.log('T4: dead endpoint, 5000 events, queue=10, dropped=4990, failed retries remain bounded');
});
