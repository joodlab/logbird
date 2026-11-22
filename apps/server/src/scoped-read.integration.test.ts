import { randomUUID } from 'node:crypto';
import { purgeProject } from '@logbird/clickhouse';
import { apiKeySchema, createApiKeyResponseSchema, createProjectResponseSchema, facetResponseSchema } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { expect, it } from 'vitest';
import { app } from './app';
import { clickhouse } from './clickhouse';
import { clearTokenKeyCache, mintViewerToken } from './read-access';
import { drainTestAudit } from './test-audit';

/**
 * #138 / #140 on real Postgres, ClickHouse, Redis and Mailpit: a scoped key or viewer token must not see anything
 * outside its scope through search (q tricks, cursors), detail (parents, counts), facets or export, and masks hold.
 */
const MAILPIT = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
const EMBED = 'https://cms.example.invalid';

it('scoped read keys and viewer tokens cannot escape their scope (real services)', async () => {
  const users: string[] = [];
  let organizationId = '';
  let project: { id: string; slug: string } | undefined;
  let ownerCookie = '';
  const console_ = (cookie: string, path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const v1 = (bearer: string, path: string, init: { method?: string; body?: unknown; origin?: string } = {}) =>
    app.request(
      `/v1${path}`,
      {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          'User-Agent': 'scoped-read-test',
          ...(init.origin ? { Origin: init.origin } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
      { incoming: { socket: { remoteAddress: '203.0.113.90' } } },
    );
  const ids = async (bearer: string, q = '', extra: Record<string, string> = {}) => {
    const r = await v1(bearer, `/events?${new URLSearchParams({ q, from: '2026-01-01T00:00:00Z', limit: '100', ...extra })}`);
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()).data as { id: string }[]).map((e) => e.id).sort();
  };
  async function login() {
    const email = `qa-scoped-read-${randomUUID()}@example.invalid`;
    expect((await console_('', '/api/auth/email-otp/send-verification-otp', 'POST', { email, type: 'sign-in' })).status).toBe(200);
    const mailbox = await (await fetch(`${MAILPIT}/api/v1/messages?limit=100`)).json();
    const message = mailbox.messages.find((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === email));
    const content = await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json();
    const response = await console_('', '/api/auth/sign-in/email-otp', 'POST', { email, otp: content.Text.match(/\b\d{6}\b/)[0] });
    expect(response.status).toBe(200);
    const { user } = await response.json();
    users.push(user.id);
    return response.headers
      .getSetCookie()
      .map((s) => s.split(';')[0])
      .join('; ');
  }
  try {
    ownerCookie = await login();
    const org = await console_(ownerCookie, '/api/auth/organization/create', 'POST', {
      name: 'QA Scoped read',
      slug: `qa-scoped-read-${randomUUID()}`,
    });
    expect(org.status).toBe(200);
    organizationId = (await org.json()).id;
    const created = await console_(ownerCookie, '/api/projects', 'POST', { name: 'QA Scoped read fixture' });
    expect(created.status).toBe(201);
    const result = createProjectResponseSchema.parse(await created.json());
    project = result.project;
    const keysPath = `/api/projects/${project.id}/keys`;
    const createKey = async (body: Record<string, unknown>) => {
      const r = await console_(ownerCookie, keysPath, 'POST', body);
      expect(r.status, await r.clone().text()).toBe(201);
      return createApiKeyResponseSchema.parse(await r.json());
    };

    // Key creation rules (contract): scope only and always on scoped-read; origins on read kinds; future expiry.
    for (const body of [
      { name: 'x', kind: 'scoped-read' },
      { name: 'x', kind: 'read', scope: { tenantId: 't1' } },
      { name: 'x', kind: 'ingest', embedOrigins: [EMBED] },
      { name: 'x', kind: 'scoped-read', scope: {} },
      { name: 'x', kind: 'read', expiresAt: '2020-01-01T00:00:00Z' },
      { name: 'x', kind: 'read', embedOrigins: ['https://cms.example.invalid/path'] },
    ])
      expect((await console_(ownerCookie, keysPath, 'POST', body)).status, JSON.stringify(body)).toBe(422);

    const read = await createKey({ name: 'CMS server', kind: 'read', embedOrigins: [EMBED] });
    expect(read.key).toMatchObject({ kind: 'read', scope: null, embedOrigins: [EMBED], expiresAt: null });
    const t1 = await createKey({ name: 'Business t1', kind: 'scoped-read', scope: { tenantId: 't1' } });
    expect(t1.key).toMatchObject({ kind: 'scoped-read', scope: { tenantId: 't1' } });
    expect(t1.secret).toMatch(/^lb_read_/);
    const site = await createKey({
      name: 'Website site_a',
      kind: 'scoped-read',
      scope: { tenantId: 't1', target: { type: 'website', id: 'site_a' } },
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const masked = await createKey({ name: 'Masked t1', kind: 'scoped-read', scope: { tenantId: 't1', mask: ['ip', 'actor_email'] } });
    const bookings = await createKey({ name: 'Bookings t1', kind: 'scoped-read', scope: { tenantId: 't1', actionPrefixes: ['booking.'] } });

    // Fixture: two tenants, one tenant-less event, the same target id under both tenants, a cross-tenant parent chain
    // and one operation spanning tenants.
    const ts = (n: number) => new Date(Date.now() - (60 - n) * 60_000).toISOString();
    const site_a = { type: 'website', id: 'site_a', name: 'Site A' };
    const events = [
      {
        id: 'qa-t1-a1',
        occurredAt: ts(1),
        action: 'booking.created',
        tenant: { id: 't1', name: 'Tenant one' },
        targets: [site_a],
        actor: { type: 'user', id: 'u1', email: 'Lina@example.invalid' },
        context: { ip: '203.0.113.7', userAgent: 'Fixture/1', operationId: 'op1' },
        metadata: { missing: ['roles:create'] },
      },
      {
        id: 'qa-t1-b1',
        occurredAt: ts(2),
        action: 'booking.cancelled',
        tenant: { id: 't1', name: 'Tenant one' },
        targets: [{ type: 'website', id: 'site_b' }],
        context: { operationId: 'op1' },
      },
      {
        id: 'qa-t2-x',
        occurredAt: ts(3),
        action: 'booking.created',
        tenant: { id: 't2', name: 'Tenant two' },
        targets: [site_a],
        context: { operationId: 'op1' },
        metadata: { missing: ['roles:create', 'staff:invite'] },
      },
      {
        id: 'qa-t1-child',
        occurredAt: ts(4),
        action: 'auth.login',
        tenant: { id: 't1', name: 'Tenant one' },
        targets: [site_a],
        context: { parentEventId: 'qa-t2-x' },
      },
      { id: 'qa-none', occurredAt: ts(5), action: 'booking.created', targets: [site_a] },
      { id: 'qa-t2-child', occurredAt: ts(6), action: 'auth.login', tenant: { id: 't2' }, context: { parentEventId: 'qa-t1-a1' } },
      // #169: the scope's target type and id exist on this event, but on DIFFERENT targets. It must not match.
      {
        id: 'qa-t1-page',
        occurredAt: ts(7),
        action: 'page.updated',
        tenant: { id: 't1', name: 'Tenant one' },
        targets: [
          { type: 'website', id: 'site_x' },
          { type: 'page', id: 'site_a' },
        ],
      },
    ];
    const ingested = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${result.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    expect(ingested.status).toBe(202);
    expect((await ingested.json()).accepted).toBe(events.length);

    const all = ['qa-none', 'qa-t1-a1', 'qa-t1-b1', 'qa-t1-child', 'qa-t1-page', 'qa-t2-child', 'qa-t2-x'];
    const tenant1 = ['qa-t1-a1', 'qa-t1-b1', 'qa-t1-child', 'qa-t1-page'];
    expect(await ids(read.secret)).toEqual(all);
    expect(await ids(t1.secret)).toEqual(tenant1);
    expect(await ids(site.secret)).toEqual(['qa-t1-a1', 'qa-t1-child']);
    expect(await ids(bookings.secret)).toEqual(['qa-t1-a1', 'qa-t1-b1']);
    // q cannot widen the scope: OR, negation, existence, other fields and free text all stay inside it.
    for (const q of [
      'tenant:t2',
      'tenant:t2 OR tenant:t1',
      '-tenant:t1',
      'tenant:*',
      '-tenant:*',
      'target:site_a',
      'action:auth.*',
      '(tenant:t2) OR (NOT tenant:t2)',
      'id:qa-t2-x OR id:qa-none',
      '"Tenant two"',
    ]) {
      const scoped = await ids(t1.secret, q);
      expect(
        scoped.every((id) => tenant1.includes(id)),
        q,
      ).toBe(true);
      expect(
        (await ids(site.secret, q)).every((id) => ['qa-t1-a1', 'qa-t1-child'].includes(id)),
        q,
      ).toBe(true);
    }
    expect(await ids(t1.secret, 'tenant:t2 OR tenant:t1')).toEqual(tenant1);
    const sql = await v1(t1.secret, `/events?${new URLSearchParams({ lang: 'sql', q: '1 OR 1' })}`);
    expect(sql.status).toBe(422);

    // Cursors bind the scope that minted them: unscoped → scoped, scope A → scope B, and B → unscoped are refused.
    const firstPage = async (bearer: string) => {
      const r = await v1(bearer, `/events?${new URLSearchParams({ from: '2026-01-01T00:00:00Z', limit: '1' })}`);
      expect(r.status).toBe(200);
      return (await r.json()).nextCursor as string;
    };
    const page = (bearer: string, cursor: string) =>
      v1(bearer, `/events?${new URLSearchParams({ from: '2026-01-01T00:00:00Z', limit: '1', cursor })}`);
    const unscopedCursor = await firstPage(read.secret);
    const t1Cursor = await firstPage(t1.secret);
    for (const [bearer, cursor] of [
      [t1.secret, unscopedCursor],
      [site.secret, t1Cursor],
      [read.secret, t1Cursor],
      [t1.secret, Buffer.from(JSON.stringify(['2030-01-01T00:00:00.000Z', 'x', 'forged'])).toString('base64url')],
    ] as const) {
      const r = await page(bearer, cursor);
      expect(r.status).toBe(422);
      expect((await r.json()).error.code).toBe('validation_error');
    }
    expect((await page(t1.secret, t1Cursor)).status).toBe(200);

    // Detail: out of scope is 404 (like unknown), the parent chain stops at the first out-of-scope parent, counts are scoped.
    // An out-of-scope id answers exactly like an id that was never stored (status and body), so existence never leaks.
    const unknown = await v1(t1.secret, '/events/qa-never-stored');
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.text();
    for (const id of ['qa-t2-x', 'qa-none', 'qa-t2-child']) {
      const r = await v1(t1.secret, `/events/${id}`);
      expect(r.status).toBe(404);
      expect(await r.text()).toBe(unknownBody);
    }
    expect((await v1(site.secret, '/events/qa-t1-b1')).status).toBe(404);
    expect((await v1(bookings.secret, '/events/qa-t1-child')).status).toBe(404);
    expect((await v1(site.secret, '/events/qa-t1-page')).status).toBe(404);
    const child = await (await v1(t1.secret, '/events/qa-t1-child')).json();
    expect(child.parents).toEqual([]);
    expect((await (await v1(read.secret, '/events/qa-t1-child')).json()).parents.map((e: { id: string }) => e.id)).toEqual(['qa-t2-x']);
    const op = await (await v1(t1.secret, '/events/qa-t1-a1')).json();
    expect({ children: op.childCount, size: op.operationSize }).toEqual({ children: 0, size: 2 });
    const opAll = await (await v1(read.secret, '/events/qa-t1-a1')).json();
    expect({ children: opAll.childCount, size: opAll.operationSize }).toEqual({ children: 1, size: 3 });
    expect((await (await v1(site.secret, '/events/qa-t1-a1')).json()).operationSize).toBe(1);

    // Facets (#140): scoped, any field including array-valued attributes, with a second level.
    const facets = async (bearer: string, params: Record<string, string>) => {
      const r = await v1(bearer, `/facets?${new URLSearchParams({ from: '2026-01-01T00:00:00Z', ...params })}`);
      expect(r.status, await r.clone().text()).toBe(200);
      return facetResponseSchema.parse(await r.json());
    };
    expect((await facets(t1.secret, { field: 'tenant' })).values.map((v) => v.value)).toEqual(['t1']);
    expect((await facets(t1.secret, { field: 'tenant', q: 'tenant:t2 OR tenant:t1' })).values).toEqual([
      { value: 't1', label: 'Tenant one', count: 4 },
    ]);
    const missing = await facets(read.secret, { field: 'attr.metadata.missing', by: 'tenant', q: 'attr.metadata.missing:*' });
    expect(missing.by).toBe('tenant');
    expect(missing.values.map(({ value, count, groups, groupsOtherCount }) => ({ value, count, groups, groupsOtherCount }))).toEqual([
      {
        value: 'roles:create',
        count: 2,
        groups: [
          { value: 't1', label: 'Tenant one', count: 1 },
          { value: 't2', label: 'Tenant two', count: 1 },
        ],
        groupsOtherCount: 0,
      },
      { value: 'staff:invite', count: 1, groups: [{ value: 't2', label: 'Tenant two', count: 1 }], groupsOtherCount: 0 },
    ]);
    const scopedMissing = await facets(t1.secret, { field: 'attr.metadata.missing', q: 'attr.metadata.missing:*' });
    expect(scopedMissing.values.map((v) => [v.value, v.count])).toEqual([['roles:create', 1]]);
    expect(scopedMissing.by).toBeNull();

    // Masks: values hidden in results and the original payload dropped; masked fields cannot be filtered or faceted.
    const maskedPage = await (await v1(masked.secret, `/events?${new URLSearchParams({ q: 'id:qa-t1-a1', from: '2026-01-01T00:00:00Z' })}`)).json();
    expect(maskedPage.data[0].context.ip).toBe('');
    expect(maskedPage.data[0].context.userAgent).toBe('Fixture/1');
    expect(maskedPage.data[0].actor.email).toMatch(/^masked:[0-9a-f]{24}$/);
    expect(JSON.stringify(maskedPage)).not.toContain('Lina@example.invalid');
    const maskedDetail = await (await v1(masked.secret, '/events/qa-t1-a1')).json();
    expect(maskedDetail.payload).toBeNull();
    expect(JSON.stringify(maskedDetail)).not.toMatch(/203\.0\.113\.7|Lina@example/i);
    for (const path of [
      `/events?${new URLSearchParams({ q: 'actor.email:lina@example.invalid' })}`,
      `/events?${new URLSearchParams({ q: 'ip:203.0.113.*' })}`,
      `/facets?${new URLSearchParams({ field: 'ip' })}`,
      `/facets?${new URLSearchParams({ field: 'tenant', by: 'actor.email' })}`,
      `/export?${new URLSearchParams({ format: 'csv', q: 'ip:203.0.113.7' })}`,
    ]) {
      const r = await v1(masked.secret, path);
      expect(r.status, path).toBe(422);
    }
    const evidence = await v1(masked.secret, '/export?format=jsonl-evidence');
    expect(evidence.status).toBe(422);
    expect((await evidence.json()).error.code).toBe('masked_export');

    // Viewer tokens: minted by read keys only, never wider than the key, never by a token.
    const mint = (bearer: string, body: unknown, origin?: string) => v1(bearer, '/viewer-tokens', { method: 'POST', body, origin });
    const minted = await mint(read.secret, { scope: { tenantId: 't1', target: { type: 'website', id: 'site_a' } } });
    expect(minted.status).toBe(201);
    expect(minted.headers.get('cache-control')).toBe('no-store');
    const token = (await minted.json()) as { token: string; expiresAt: string };
    expect(token.token).toMatch(/^lbv1\.[\w-]+\.[\w-]+$/);
    expect(Date.parse(token.expiresAt) - Date.now()).toBeGreaterThan(890_000);
    expect(Date.parse(token.expiresAt) - Date.now()).toBeLessThanOrEqual(900_000);
    for (const [bearer, body] of [
      [site.secret, { scope: { tenantId: 't1' } }],
      [t1.secret, { scope: { tenantId: 't2' } }],
      [bookings.secret, { scope: { tenantId: 't1' } }],
      [bookings.secret, { scope: { tenantId: 't1', actionPrefixes: ['auth.'] } }],
      [masked.secret, { scope: { tenantId: 't1', mask: ['ip'] } }],
    ] as const) {
      const r = await mint(bearer, body);
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect((await r.json()).error.code).toBe('scope_exceeded');
    }
    expect((await mint(bookings.secret, { scope: { tenantId: 't1', actionPrefixes: ['booking.created'] } })).status).toBe(201);
    expect((await mint(read.secret, { scope: { tenantId: 't1' }, ttlSeconds: 7200 })).status).toBe(422);
    expect((await mint(token.token, { scope: { tenantId: 't1' } })).status).toBe(403);
    expect((await mint(result.ingestKey.secret, { scope: { tenantId: 't1' } })).status).toBe(401);

    expect(await ids(token.token)).toEqual(['qa-t1-a1', 'qa-t1-child']);
    expect(await ids(token.token, 'tenant:t2 OR target:site_b')).toEqual([]);
    expect((await v1(token.token, '/events/qa-t2-x')).status).toBe(404);
    // A token is a read credential only: never for ingest.
    expect((await v1(token.token, '/events', { method: 'POST', body: { action: 'x' } })).status).toBe(401);
    // Tampering with the payload (another tenant) breaks the MAC; an expired token is refused.
    const [prefix, body, mac] = token.token.split('.');
    const payload = JSON.parse(Buffer.from(body ?? '', 'base64url').toString());
    const forged = `${prefix}.${Buffer.from(JSON.stringify({ ...payload, s: { tenantId: 't2' } })).toString('base64url')}.${mac}`;
    expect((await v1(forged, '/events')).status).toBe(401);
    const old = mintViewerToken(
      { keyId: read.key.id, projectId: project.id, scope: { tenantId: 't1' }, ttlSeconds: 60 },
      undefined,
      Date.now() - 120_000,
    );
    expect((await v1(old.token, '/events')).status).toBe(401);

    // CORS: only the minting key's embed origins can read token responses; no cookies are ever allowed.
    const preflight = await app.request('/v1/events', {
      method: 'OPTIONS',
      headers: { Origin: EMBED, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(EMBED);
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    const browser = await v1(token.token, '/events', { origin: EMBED });
    expect(browser.status).toBe(200);
    expect(browser.headers.get('access-control-allow-origin')).toBe(EMBED);
    expect(browser.headers.get('access-control-allow-credentials')).toBeNull();
    expect(browser.headers.get('access-control-expose-headers')).toContain('RateLimit-Remaining');
    const evil = await v1(token.token, '/events', { origin: 'https://evil.example.invalid' });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const siteToken = (await (await mint(site.secret, { scope: { tenantId: 't1', target: { type: 'website', id: 'site_a' } } })).json()).token;
    expect((await v1(siteToken, '/events', { origin: EMBED })).status).toBe(403); // that key lists no origins
    expect((await v1(siteToken, '/events')).status).toBe(200); // server-to-server still works
    // A read key used from a browser gets no CORS: keys belong on servers.
    expect((await v1(read.secret, '/events', { origin: EMBED })).headers.get('access-control-allow-origin')).toBeNull();

    // Export with a viewer token: only in-scope rows; audited with the key as actor and the tenant/token recorded.
    const exported = await v1(token.token, `/export?${new URLSearchParams({ format: 'jsonl', from: '2026-01-01T00:00:00Z' })}`);
    expect(exported.status).toBe(200);
    const exportId = exported.headers.get('x-logbird-export-id');
    expect(exported.headers.get('x-logbird-export-schema')).toMatch(/^jsonl\//);
    const lines = (await exported.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: string });
    expect(lines.map((e) => e.id).sort()).toEqual(['qa-t1-a1', 'qa-t1-child']);
    const csv = await (await v1(masked.secret, `/export?${new URLSearchParams({ format: 'csv', from: '2026-01-01T00:00:00Z' })}`)).text();
    // Row ids only (qa-t1-child's own parentEventId legitimately names its out-of-scope parent).
    expect(
      csv
        .trim()
        .split('\n')
        .slice(1)
        .map((row) => row.split(',')[0])
        .sort(),
    ).toEqual(['"qa-t1-a1"', '"qa-t1-b1"', '"qa-t1-child"', '"qa-t1-page"']);
    expect(csv).not.toMatch(/203\.0\.113\.7|Lina@example/);
    await drainTestAudit(organizationId);
    const receipts = await (
      await clickhouse.query({
        query: "SELECT payload FROM events WHERE project_id={p:String} AND operation_id={id:String} AND action='export.completed'",
        query_params: { p: `ws:${organizationId}`, id: exportId ?? '' },
        format: 'JSONEachRow',
      })
    ).json<{ payload: string }>();
    const completed = JSON.parse(receipts[0]?.payload ?? '{}');
    expect(completed.actor).toMatchObject({ type: 'api_key', id: read.key.id, name: 'CMS server' });
    expect(completed.metadata.access).toMatchObject({ via: 'viewer_token', apiKeyId: read.key.id, viaToken: true, tenantId: 't1' });
    expect(completed.metadata.export.rows).toBe(2);

    // Rolling copies scope, origins and the absolute expiry (a replacement never outlives the key it replaces unless the
    // roll passes a new expiry); revoking or expiring the key kills it and its tokens.
    const rolled = await console_(ownerCookie, `${keysPath}/${site.key.id}/roll`, 'POST');
    expect(rolled.status).toBe(201);
    const replacement = createApiKeyResponseSchema.parse(await rolled.json());
    expect(replacement.key).toMatchObject({ kind: 'scoped-read', scope: site.key.scope, embedOrigins: [], expiresAt: site.key.expiresAt });
    expect(site.key.expiresAt).not.toBeNull();
    const rolledRead = createApiKeyResponseSchema.parse(await (await console_(ownerCookie, `${keysPath}/${read.key.id}/roll`, 'POST')).json());
    expect(rolledRead.key).toMatchObject({ kind: 'read', scope: null, embedOrigins: [EMBED], expiresAt: null });
    const later = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const extended = await console_(ownerCookie, `${keysPath}/${site.key.id}/roll`, 'POST', { expiresAt: later });
    expect(extended.status).toBe(201);
    expect(createApiKeyResponseSchema.parse(await extended.json()).key.expiresAt).toBe(later);
    expect((await console_(ownerCookie, `${keysPath}/${site.key.id}/roll`, 'POST', { expiresAt: '2020-01-01T00:00:00Z' })).status).toBe(422);
    expect((await console_(ownerCookie, `${keysPath}/${site.key.id}/roll`, 'POST', { scope: { tenantId: 't2' } })).status).toBe(422);
    expect(await ids(replacement.secret)).toEqual(['qa-t1-a1', 'qa-t1-child']);
    const listed = (await (await console_(ownerCookie, keysPath)).json()).data.map((k: unknown) => apiKeySchema.parse(k));
    expect(listed.find((k: { id: string }) => k.id === t1.key.id)).toMatchObject({ kind: 'scoped-read', scope: { tenantId: 't1' } });
    await prisma.apiKey.update({ where: { id: t1.key.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await v1(t1.secret, '/events')).status).toBe(401);
    const expiredRoll = await console_(ownerCookie, `${keysPath}/${t1.key.id}/roll`, 'POST');
    expect(expiredRoll.status).toBe(409);
    expect((await expiredRoll.json()).error.code).toBe('key_expired');
    expect((await console_(ownerCookie, `${keysPath}/${t1.key.id}/roll`, 'POST', { expiresAt: later })).status).toBe(201);
    expect((await console_(ownerCookie, `${keysPath}/${read.key.id}`, 'DELETE')).status).toBe(204);
    expect((await v1(read.secret, '/events')).status).toBe(401);
    clearTokenKeyCache(); // tokens die with their key within the 30 s cache window; skip the wait here
    expect((await v1(token.token, '/events')).status).toBe(401);
    // Ingest keys cannot read; the ingest path still works for ingest keys only.
    expect((await v1(result.ingestKey.secret, '/events')).status).toBe(401);
  } finally {
    clearTokenKeyCache();
    if (project) expect((await console_(ownerCookie, `/api/projects/${project.id}?confirm=${project.slug}`, 'DELETE')).status).toBe(204);
    if (organizationId) {
      await prisma.exportLease.deleteMany({ where: { workspaceId: organizationId } });
      await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${organizationId}` } });
      await purgeProject(clickhouse, `ws:${organizationId}`);
      await prisma.organization.delete({ where: { id: organizationId } });
    }
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
}, 360_000);
