import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createClickHouseClient } from '@trailmark/clickhouse';
import * as s from '@trailmark/contracts';
import { prisma } from '@trailmark/database';
import { Trailmark } from '@trailmark/sdk';
import { client, endpoint, login } from './http';

const ch = createClickHouseClient();
const email = `smoke-${randomUUID()}@example.test`;
const cookie = await login(email),
  api = client(cookie);
let organizationId: string | undefined;
const invitedEmail = `invite-${randomUUID()}@example.test`;
try {
  const org = await (await api('/api/auth/organization/create', 'POST', { name: 'Smoke fixture', slug: `smoke-${randomUUID()}` })).json();
  organizationId = (org as { id: string }).id;
  await api('/api/auth/organization/set-active', 'POST', { organizationId });
  const invitation = (await (
    await api('/api/auth/organization/invite-member', 'POST', { email: invitedEmail, role: 'member', organizationId })
  ).json()) as { id: string };
  const invitedApi = client(await login(invitedEmail));
  await invitedApi('/api/auth/organization/accept-invitation', 'POST', { invitationId: invitation.id });
  const invited = await prisma.user.findUniqueOrThrow({ where: { email: invitedEmail } });
  const member = await prisma.member.findFirstOrThrow({ where: { userId: invited.id, organizationId } });
  await api('/api/auth/organization/update-member-role', 'POST', { memberId: member.id, role: 'admin', organizationId });
  await api('/api/auth/organization/remove-member', 'POST', { memberIdOrEmail: member.id, organizationId });
  await login(email);
  const created = s.createProjectResponseSchema.parse(await (await api('/api/projects', 'POST', { name: 'Smoke project' })).json());
  const p = created.project,
    base = `/api/projects/${p.id}`;
  const errors: Error[] = [];
  const sdk = new Trailmark({ apiKey: created.ingestKey.secret, endpoint, onError: (e) => errors.push(e) });
  sdk.track({
    id: 'smoke-root',
    action: 'hotel.updated',
    actor: { id: 'smoke-user', type: 'user' },
    targets: [{ type: 'hotel', id: 'sample' }],
    metadata: { plan: 'pro' },
    context: { operationId: 'smoke-op' },
    description: 'Fictional hotel update',
  });
  sdk.track({
    action: 'legacy.accepted',
    outcome: 'custom',
    custom: { locale: 'ar' },
    context: { operationId: 'smoke-op', parentEventId: 'smoke-root' },
  });
  sdk.track({
    action: 'old.record',
    occurredAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    actor: { id: 'old-user' },
    metadata: { oldOnly: true },
  });
  await sdk.shutdown();
  assert.deepEqual(errors, []);
  for (const q of ['action:hotel.*', 'attr.metadata.plan:pro', 'actor:smoke-user -outcome:failure', '"Fictional"']) {
    const result = s.searchResponseSchema.parse(await (await api(`${base}/events?q=${encodeURIComponent(q)}`)).json());
    assert.equal(result.data.length, 1);
  }
  s.eventDetailSchema.parse(await (await api(`${base}/events/smoke-root`)).json());
  assert.equal(s.eventSchema.array().parse(await (await api(`${base}/operations/smoke-op`)).json()).length, 2);
  s.overviewResponseSchema.parse(await (await api(`${base}/overview`)).json());
  s.histogramResponseSchema.parse(await (await api(`${base}/histogram`)).json());
  s.facetResponseSchema.parse(await (await api(`${base}/facets?field=action`)).json());
  const entities = s.entityListResponseSchema.parse(await (await api(`${base}/entities?kind=actor`)).json());
  assert.ok(entities.data.length);
  s.entityProfileSchema.parse(await (await api(`${base}/entities/actor/smoke-user`)).json());
  s.fieldsResponseSchema.parse(await (await api(`${base}/fields`)).json());
  assert.match(await (await api(`${base}/export?format=csv`)).text(), /hotel.updated/);
  assert.match((await api(`${base}/export?format=jsonl`)).headers.get('content-disposition') ?? '', /attachment/);
  s.eventSchema.array().parse(await (await api(`${base}/live?since=${new Date(Date.now() - 60_000).toISOString()}`)).json());
  s.ingestResponseSchema.parse(await (await api(`${base}/test-event`, 'POST', {})).json());
  const read = s.createApiKeyResponseSchema.parse(await (await api(`${base}/keys`, 'POST', { name: 'Read', kind: 'read' })).json());
  const pub = await fetch(`${endpoint}/v1/events`, { headers: { Authorization: `Bearer ${read.secret}` } });
  assert.equal(pub.status, 200);
  s.searchResponseSchema.parse(await pub.json());
  const detail = await fetch(`${endpoint}/v1/events/smoke-root`, { headers: { Authorization: `Bearer ${read.secret}` } });
  assert.equal(detail.status, 200);
  s.eventDetailSchema.parse(await detail.json());
  for (const suffix of ['/events?q=OR', '/events?from=garbage', '/events?cursor=invalid', '/export?format=csv&q=OR']) {
    const invalid = await fetch(`${endpoint}${base}${suffix}`, { headers: { cookie } });
    assert.equal(invalid.status, 422);
    s.apiErrorSchema.parse(await invalid.json());
  }
  const openapi = (await (await fetch(`${endpoint}/openapi.json`)).json()) as { paths: Record<string, unknown> };
  const checkRoutes = (value: unknown): void => {
    if (value && typeof value === 'object') {
      if ('path' in value && typeof value.path === 'string') {
        // The OpenAPI generator omits its own document endpoint.
        if (value.path !== '/openapi.json') assert.ok(openapi.paths[value.path.replace(/:([A-Za-z]+)/g, '{$1}')], value.path);
      } else for (const child of Object.values(value)) checkRoutes(child);
    }
  };
  checkRoutes(s.routes);
  const headers = { Authorization: `Bearer ${created.ingestKey.secret}`, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' };
  const mixed = await fetch(`${endpoint}/v1/events`, {
    method: 'POST',
    headers,
    body: gzipSync(JSON.stringify({ events: [{ action: 'gzip.event' }, {}] })),
  });
  assert.equal(mixed.status, 202);
  assert.equal(s.ingestResponseSchema.parse(await mixed.json()).rejected.length, 1);
  for (const body of [
    { events: Array.from({ length: 1001 }, () => ({ action: 'limit' })) },
    { action: 'limit', blob: 'x'.repeat(256 * 1024) },
    { action: 'limit', blob: 'x'.repeat(5 * 1024 * 1024) },
  ]) {
    const r = await fetch(`${endpoint}/v1/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 413);
    s.apiErrorSchema.parse(await r.json());
  }
  const view = s.savedViewSchema.parse(
    await (await api(`${base}/views`, 'POST', { name: 'Smoke', description: null, state: { q: 'hotel' } })).json(),
  );
  await api(`${base}/views/${view.id}`, 'DELETE');
  await api(`${base}/keys/${read.key.id}`, 'DELETE');
  const refused = await fetch(`${endpoint}${base}`, {
    method: 'PATCH',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ retentionDays: 7 }),
  });
  assert.equal(refused.status, 422);
  await api(base, 'PATCH', { retentionDays: 7, confirm: p.slug });
  const run = await prisma.retentionRun.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { startedAt: 'desc' } });
  assert.equal(run.status, 'completed');
  assert.equal(run.deletedEvents, 1);
  const remaining = s.entityListResponseSchema.parse(await (await api(`${base}/entities?kind=actor`)).json());
  assert.ok(!remaining.data.some((e) => e.id === 'old-user'));
  const stats = s.projectSchema.parse(await (await api(base)).json());
  assert.ok(stats.eventsLast24h >= 4);
  assert.ok(stats.lastEventAt);
  await api(base, 'DELETE');
  for (const table of ['events', 'events_by_minute', 'entities', 'attribute_keys']) {
    const rows = await (
      await ch.query({ query: `SELECT count() n FROM ${table} WHERE project_id={p:String}`, query_params: { p: p.id }, format: 'JSONEachRow' })
    ).json<{ n: string }>();
    assert.equal(Number(rows[0]?.n), 0);
  }
  const activity = s.searchResponseSchema.parse(await (await api('/api/workspace/activity')).json());
  for (const action of [
    'organization.created',
    'member.invited',
    'member.role.changed',
    'member.removed',
    'auth.signed_in',
    'project.created',
    'project.updated',
    'project.deleted',
    'project.retention.changed',
    'api_key.created',
    'api_key.revoked',
    'saved_view.created',
    'saved_view.deleted',
  ])
    assert.ok(
      activity.data.some((e) => e.action === action),
      action,
    );
  console.log(
    'PASS OTP, org, SDK/off-standard/gzip/limits, query/detail/operation, all data schemas, exports, stats, retention counts/derived rebuild, activity, full purge',
  );
} finally {
  if (organizationId) {
    for (const project of await prisma.project.findMany({ where: { organizationId } }))
      await (await import('@trailmark/clickhouse')).purgeProject(ch, project.id);
    await (await import('@trailmark/clickhouse')).purgeProject(ch, `ws:${organizationId}`);
    await prisma.organization.delete({ where: { id: organizationId } });
  }
  await prisma.user.deleteMany({ where: { email: { in: [email, invitedEmail] } } });
  await ch.close();
  await prisma.$disconnect();
}
