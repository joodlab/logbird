import { randomUUID } from 'node:crypto';
import { insertEvents, normalizeEvent, purgeProject } from '@logbird/clickhouse';
import * as s from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { expect, it } from 'vitest';
import { app } from './app';
import { clickhouse } from './clickhouse';
import { drainTestAudit } from './test-audit';

/**
 * #63 / #65 server halves against real Postgres, ClickHouse, Redis and Mailpit, in process (no listeners), with a
 * fictional workspace on its own fictional email domain that is removed afterwards.
 */
it('real services: key roll + last-used client, empty-project delete, landing project, workspace-name pre-fill, view labels', async () => {
  const domain = `qa-fix-backlogs-${randomUUID().slice(0, 8)}.test`;
  const email = `owner@${domain}`;
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  expect((await request('/api/auth/email-otp/send-verification-otp', 'POST', { email, type: 'sign-in' })).status).toBe(200);
  const mailpit = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
  let otp: string | undefined;
  for (let attempt = 0; attempt < 30 && !otp; attempt++) {
    const mailbox = (await (await fetch(`${mailpit}/api/v1/messages`)).json()) as { messages: { ID: string; To: { Address: string }[] }[] };
    const message = mailbox.messages.find((m) => m.To.some((t) => t.Address === email));
    if (message) otp = ((await (await fetch(`${mailpit}/api/v1/message/${message.ID}`)).json()) as { Text: string }).Text.match(/\b\d{6}\b/)?.[0];
    if (!otp) await new Promise((r) => setTimeout(r, 200));
  }
  const login = await request('/api/auth/sign-in/email-otp', 'POST', { email, otp });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const response = await request(path, method, body, { cookie });
    expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBeLessThan(300);
    return response;
  };
  const projectIds: string[] = [];
  let orgId: string | undefined;
  const event = (projectId: string, minutesAgo: number, extra: Record<string, unknown> = {}) => {
    const result = normalizeEvent(
      { action: 'qa.fixture', occurredAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(), ...extra },
      { projectId, receivedAt: new Date() },
    );
    if (!result.ok) throw new Error(result.reason);
    return result.row;
  };
  try {
    await api('/api/auth/update-user', 'POST', { name: 'QA Fix Owner' });

    // OWNER-15: a company domain nobody uses yet is pre-filled; once a workspace exists there, it is not.
    const before = s.workspaceNameSuggestionSchema.parse(await (await api('/api/onboarding/workspace-name')).json());
    expect(before.name).toMatch(/^Qa Fix Backlogs [0-9a-f]{8}$/i);
    orgId = (
      (await (await api('/api/auth/organization/create', 'POST', { name: 'QA Fix backlogs', slug: `qa-fix-${randomUUID()}` })).json()) as {
        id: string;
      }
    ).id;
    await api('/api/auth/organization/set-active', 'POST', { organizationId: orgId });
    expect(s.workspaceNameSuggestionSchema.parse(await (await api('/api/onboarding/workspace-name')).json()).name).toBeNull();

    const create = async (name: string) => {
      const created = s.createProjectResponseSchema.parse(await (await api('/api/projects', 'POST', { name })).json());
      projectIds.push(created.project.id);
      return created.project;
    };
    const busy = await create('QA Fix busy');
    const fixture = await create('QA Fix test fixture');

    // OPS-19: land on the project with the most traffic, not the one that got a single event last.
    await insertEvents(clickhouse, [event(busy.id, 30), event(busy.id, 20), event(busy.id, 10), event(fixture.id, 1)]);
    const setup = s.workspaceSetupSchema.parse(await (await api('/api/workspace/setup')).json());
    expect(setup.onboarding).toEqual({ next: null, projectId: busy.id });

    // OWNER-11: roll a key; the old one keeps working and records the client that last used it.
    const read = s.createApiKeyResponseSchema.parse(
      await (await api(`/api/projects/${busy.id}/keys`, 'POST', { name: 'QA Fix reader', kind: 'read' })).json(),
    );
    const asKey = (secret: string) =>
      request('/v1/events?limit=1', 'GET', undefined, { Authorization: `Bearer ${secret}`, 'User-Agent': 'qa-fix-client/1.0' });
    expect((await asKey(read.secret)).status).toBe(200);
    const rolled = await request(`/api/projects/${busy.id}/keys/${read.key.id}/roll`, 'POST', undefined, { cookie });
    expect(rolled.status).toBe(201);
    const replacement = s.createApiKeyResponseSchema.parse(await rolled.json());
    expect(replacement.key).toMatchObject({ name: 'QA Fix reader', kind: 'read', replacesKeyId: read.key.id, revokedAt: null });
    expect(replacement.secret).not.toBe(read.secret);
    expect((await asKey(read.secret)).status).toBe(200);
    expect((await asKey(replacement.secret)).status).toBe(200);
    const listed = s.apiKeyListResponseSchema.parse(await (await api(`/api/projects/${busy.id}/keys`)).json()).data;
    const old = listed.find((k) => k.id === read.key.id);
    expect(old?.lastUsedAt).not.toBeNull();
    expect(old?.lastUsedUserAgent).toBe('qa-fix-client/1.0');
    await api(`/api/projects/${busy.id}/keys/${read.key.id}`, 'DELETE');
    expect((await asKey(read.secret)).status).toBe(401);
    expect((await asKey(replacement.secret)).status).toBe(200);
    expect((await request(`/api/projects/${busy.id}/keys/${read.key.id}/roll`, 'POST', undefined, { cookie })).status).toBe(409);
    await drainTestAudit(orgId);
    const audit = await (
      await clickhouse.query({
        query: "SELECT description FROM events WHERE project_id={p:String} AND action='api_key.created' ORDER BY timestamp",
        query_params: { p: `ws:${orgId}` },
        format: 'JSONEachRow',
      })
    ).json<{ description: string }>();
    expect(audit.some((row) => row.description.startsWith('Rolled the read key “QA Fix reader”'))).toBe(true);

    // OPS-17: saved views keep display names for their entity terms.
    const view = s.savedViewSchema.parse(
      await (
        await api(`/api/projects/${busy.id}/views`, 'POST', {
          name: 'Bayt Al Rimal — last 7 days',
          description: null,
          state: { q: 'tenant:biz_5', lang: 'query', range: '7d', labels: [{ field: 'tenant', value: 'biz_5', label: 'Bayt Al Rimal' }] },
        })
      ).json(),
    );
    expect(view.state.labels).toEqual([{ field: 'tenant', value: 'biz_5', label: 'Bayt Al Rimal' }]);

    // OWNER-08: an empty, brand-new project deletes in well under a second; a project with data is still purged.
    const empty = await create('QA Fix empty');
    // A failed/ambiguous ingest can leave an unresolved, claimed receipt while every ClickHouse table is empty (#62).
    // The fast path must still remove it, or hourly recovery would keep failing on the deleted project.
    await prisma.ingestReceipt.create({
      data: {
        projectId: empty.id,
        eventId: `qa-fix-orphan-${randomUUID()}`,
        organizationId: orgId,
        fingerprint: 'qa-fix-fingerprint',
        receivedAt: new Date(Date.now() - 3_600_000),
        eventAt: new Date(Date.now() - 3_600_000),
        claimedAt: new Date(Date.now() - 3_600_000),
        confirmedAt: null,
      },
    });
    expect(await prisma.ingestReceipt.count({ where: { projectId: empty.id, confirmedAt: null } })).toBe(1);
    const started = performance.now();
    const removed = await request(`/api/projects/${empty.id}?confirm=${encodeURIComponent(empty.slug)}`, 'DELETE', undefined, { cookie });
    const emptyDeleteMs = performance.now() - started;
    expect(removed.status).toBe(204);
    expect(emptyDeleteMs).toBeLessThan(1000);
    // The fast path skips only ClickHouse mutations: the PostgreSQL side of the deletion still ran in full.
    expect(await prisma.project.findUnique({ where: { id: empty.id } })).toBeNull();
    expect(await prisma.apiKey.count({ where: { projectId: empty.id } })).toBe(0);
    expect(await prisma.ingestReceipt.count({ where: { projectId: empty.id } })).toBe(0);
    await drainTestAudit(orgId);
    const deletion = await (
      await clickhouse.query({
        query: `SELECT action, JSONExtractString(payload, 'metadata', 'apiKey', 'reason') reason FROM events
          WHERE project_id={ws:String} AND has(target_ids, {p:String}) AND action IN ('project.deleted', 'api_key.revoked')`,
        query_params: { ws: `ws:${orgId}`, p: empty.id },
        format: 'JSONEachRow',
      })
    ).json<{ action: string; reason: string }>();
    expect(deletion).toEqual(
      expect.arrayContaining([
        { action: 'project.deleted', reason: '' },
        { action: 'api_key.revoked', reason: 'project_deleted' },
      ]),
    );
    const withData = await request(`/api/projects/${fixture.id}?confirm=${encodeURIComponent(fixture.slug)}`, 'DELETE', undefined, { cookie });
    expect(withData.status).toBe(204);
    const [left] = await (
      await clickhouse.query({
        query: 'SELECT count() n FROM events WHERE project_id={p:String}',
        query_params: { p: fixture.id },
        format: 'JSONEachRow',
      })
    ).json<{ n: string }>();
    expect(Number(left?.n)).toBe(0);
    process.stdout.write(`[console-backlogs] empty project delete: ${Math.round(emptyDeleteMs)} ms\n`);
  } finally {
    for (const p of projectIds) await purgeProject(clickhouse, p);
    if (orgId) {
      await drainTestAudit(orgId).catch(() => undefined);
      await purgeProject(clickhouse, `ws:${orgId}`);
      await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { email } });
  }
}, 240_000);
