import { randomUUID } from 'node:crypto';
import { insertEvents, normalizeEvent, purgeProject, setupEventFacts } from '@trailmark/clickhouse';
import * as s from '@trailmark/contracts';
import { prisma } from '@trailmark/database';
import { expect, it } from 'vitest';
import { app } from './app';
import { clickhouse } from './clickhouse';

it('real services: setup, keys, raw envelope coverage, samples, membership and invitations', async () => {
  const email = `setup-${randomUUID()}@example.test`;
  const request = async (path: string, method = 'GET', body?: unknown, cookie = '') =>
    app.request(path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  expect((await request('/api/auth/email-otp/send-verification-otp', 'POST', { email, type: 'sign-in' })).status).toBe(200);
  const mailbox = (await (await fetch('http://127.0.0.1:8025/api/v1/messages')).json()) as { messages: { ID: string; To: { Address: string }[] }[] };
  const message = mailbox.messages.find((m) => m.To.some((t) => t.Address === email));
  expect(message).toBeDefined();
  const content = (await (await fetch(`http://127.0.0.1:8025/api/v1/message/${message?.ID}`)).json()) as { Text: string };
  const login = await request('/api/auth/sign-in/email-otp', 'POST', { email, otp: content.Text.match(/\b\d{6}\b/)?.[0] });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const response = await request(path, method, body, cookie);
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return response;
  };
  let orgId: string | undefined;
  const projectIds: string[] = [];
  try {
    expect(s.workspaceSetupSchema.parse(await (await api('/api/workspace/setup')).json()).organizationId).toBeNull();
    await api('/api/auth/update-user', 'POST', { name: 'Setup Tester' });
    orgId = (
      (await (await api('/api/auth/organization/create', 'POST', { name: 'Setup fixture', slug: `setup-${randomUUID()}` })).json()) as { id: string }
    ).id;
    await api('/api/auth/organization/set-active', 'POST', { organizationId: orgId });
    expect(s.workspaceSetupSchema.parse(await (await api('/api/workspace/setup')).json()).onboarding.next).toBe('project');
    const created = s.createProjectResponseSchema.parse(await (await api('/api/projects', 'POST', { name: 'Setup fixture' })).json());
    const p = created.project.id;
    projectIds.push(p);
    const neighbor = await prisma.project.create({ data: { organizationId: orgId, name: 'Neighbor fixture', slug: randomUUID() } });
    projectIds.push(neighbor.id);
    const neighborEvent = normalizeEvent(
      { action: 'neighbor.sample', source: s.SAMPLE_DATA_SOURCE },
      { projectId: neighbor.id, receivedAt: new Date() },
    );
    if (!neighborEvent.ok) throw new Error(neighborEvent.reason);
    await insertEvents(clickhouse, [neighborEvent.row]);

    const base = `/api/projects/${p}`;
    const status = async () => s.projectSetupSchema.parse(await (await api(`${base}/setup`)).json());
    let state = await status();
    expect(state.progress.done).toBe(1);
    expect(state.nextStep).toBe('first_event');
    expect(state.ingest.firstEventAt).toBeNull();
    expect(s.workspaceSetupSchema.parse(await (await api('/api/workspace/setup')).json()).onboarding.next).toBe('first_event');
    await api(`${base}/keys/${created.ingestKey.key.id}`, 'DELETE');
    expect((await status()).progress.done).toBe(0);
    const key = s.createApiKeyResponseSchema.parse(await (await api(`${base}/keys`, 'POST', { name: 'Fixture ingest', kind: 'ingest' })).json());
    await api(`${base}/keys`, 'POST', { name: 'Fixture read', kind: 'read' });
    expect((await status()).readKeys.active).toBe(1);
    expect((await api(`${base}/sample-data`, 'POST')).status).toBe(200);
    state = await status();
    expect(state.ingest.sampleEvents).toBe(2000);
    expect(state.ingest.firstEventAt).toBeNull();
    expect(state.steps.find((s) => s.id === 'first_event')?.status).toBe('attention');
    await api(`${base}/sample-data`, 'POST');
    expect((await status()).ingest.sampleEvents).toBe(2000);
    await api(`${base}/sample-data`, 'DELETE');
    expect((await status()).ingest.sampleEvents).toBe(0);
    const ingest = async (event: unknown) => {
      const r = await app.request('/v1/events', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      expect(r.status, await r.clone().text()).toBe(202);
    };
    await ingest({ action: 'x' });
    state = await status();
    expect(state.ingest.firstEvent?.action).toBe('x');
    expect(state.steps.find((s) => s.id === 'envelope')?.status).toBe('attention');
    expect(state.envelope.fields.every((f) => f.coverage === 0)).toBe(true);
    await ingest({
      action: 'reservation.created',
      occurredAt: new Date().toISOString(),
      outcome: 'success',
      actor: { id: 'fixture-user', type: 'user' },
      tenant: { id: 'fixture-tenant' },
      executor: { type: 'api' },
      targets: [{ id: 'fixture-reservation', type: 'reservation' }],
      context: { operationId: 'fixture-operation' },
      description: 'Created fictional reservation',
    });
    state = await status();
    expect(state.envelope.fields.every((f) => f.coverage === 0.5)).toBe(true);
    expect(state.operations.coverage).toBe(0.5);
    // timestamp is not an accepted occurredAt alias in the current normalizer.
    await ingest({ action: 'alias', timestamp: new Date().toISOString() });
    expect((await status()).envelope.fields.find((f) => f.field === 'occurredAt')?.coverage).toBeCloseTo(1 / 3);
    expect((await request(base, 'PATCH', { retentionDays: 7 }, cookie)).status).toBe(422);
    expect((await status()).retention.reviewedAt).toBeNull();
    await api(base, 'PATCH', { retentionDays: 180 });
    expect((await status()).retention.reviewedAt).not.toBeNull();
    await api(`${base}`, 'PATCH', { retentionReviewed: true, setupDismissed: true });
    state = await status();
    expect(state.retention.reviewedAt).not.toBeNull();
    expect(state.dismissedAt).not.toBeNull();
    await api(`${base}`, 'PATCH', { setupDismissed: false });
    expect((await status()).dismissedAt).toBeNull();
    await api('/api/auth/organization/invite-member', 'POST', {
      email: `invited-${randomUUID()}@example.test`,
      role: 'member',
      organizationId: orgId,
    });
    state = await status();
    expect(state.team.pendingInvitations).toBe(1);
    expect(state.steps.find((s) => s.id === 'teammate')?.status).toBe('done');
    expect(s.workspaceSetupSchema.parse(await (await api('/api/workspace/setup')).json()).onboarding.next).toBeNull();
    expect((await request(`${base}/setup`)).status).toBe(401);
    // Real samples are removed without damaging either the original event or rollups.
    await api(`${base}/sample-data`, 'POST');
    await api(`${base}/sample-data`, 'DELETE');
    state = await status();
    expect(state.ingest.sampleEvents).toBe(0);
    expect(state.ingest.firstEvent?.action).toBe('x');
    expect((await setupEventFacts(clickhouse, neighbor.id)).sampleEvents).toBe(1);
    const fields = s.fieldsResponseSchema.parse(await (await api(`${base}/fields`)).json());
    expect(fields.data.some((f) => f.key === 'attr.metadata.channel')).toBe(false);
    const entities = s.entityListResponseSchema.parse(await (await api(`${base}/entities?kind=actor`)).json());
    expect(entities.data.map((e) => e.id)).toEqual(['fixture-user']);
    // A separate project and backdated occurrence prove arrival-time semantics and isolation.
    const other = await prisma.project.create({ data: { organizationId: orgId, name: 'Other fixture', slug: randomUUID() } });
    projectIds.push(other.id);
    const normalized = normalizeEvent({ action: 'backdated', occurredAt: '2020-01-01T00:00:00Z' }, { projectId: other.id, receivedAt: new Date() });
    if (!normalized.ok) throw new Error(normalized.reason);
    await insertEvents(clickhouse, [normalized.row]);
    expect((await setupEventFacts(clickhouse, other.id)).eventsLast24h).toBe(1);
    expect((await status()).ingest.eventsLast24h).toBe(3);
    const openapi = (await (await api('/openapi.json')).json()) as { paths: Record<string, unknown> };
    expect(openapi.paths['/api/projects/{projectId}/setup']).toBeDefined();
  } finally {
    for (const p of projectIds) await purgeProject(clickhouse, p);
    if (orgId) {
      await purgeProject(clickhouse, `ws:${orgId}`);
      await prisma.organization.delete({ where: { id: orgId } });
    }
    await prisma.user.deleteMany({ where: { email } });
  }
}, 120_000);
