import { randomUUID } from 'node:crypto';
import { purgeProject } from '@logbird/clickhouse';
import { apiKeySchema, createApiKeyResponseSchema, createProjectResponseSchema, facetResponseSchema } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { expect, it } from 'vitest';
import { app } from './app';
import { clickhouse, queryClickhouse } from './clickhouse';
import { clearTokenKeyCache, mintViewerToken, tokenKey } from './read-access';
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
      // Whitespace-padded ids: ingest trims them, so these are STORED as tenant "t1", target "site_a" and action
      // "booking.leak". Maintainer decision (#180): a scope names stored ids, so they belong to those scopes.
      { id: 'qa-collide-tenant', occurredAt: ts(8), action: 'booking.created', tenant: { id: 't1 ', name: 'Tenant one' }, targets: [site_a] },
      {
        id: 'qa-collide-target',
        occurredAt: ts(9),
        action: 'booking.created',
        tenant: { id: 't1', name: 'Tenant one' },
        targets: [{ type: 'website', id: 'site_a ' }],
      },
      { id: 'qa-collide-action', occurredAt: ts(10), action: ' booking.leak', tenant: { id: 't1', name: 'Tenant one' } },
      // A literal dotted key: stored as the attribute path "context.ip", which an ip mask hides like the real field.
      { id: 'qa-dotted-ip', occurredAt: ts(11), action: 'auth.login', tenant: { id: 't1', name: 'Tenant one' }, 'context.ip': '198.51.100.9' },
    ];
    const ingested = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${result.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    expect(ingested.status).toBe(202);
    expect((await ingested.json()).accepted).toBe(events.length);

    const all = [
      'qa-collide-action',
      'qa-collide-target',
      'qa-collide-tenant',
      'qa-dotted-ip',
      'qa-none',
      'qa-t1-a1',
      'qa-t1-b1',
      'qa-t1-child',
      'qa-t1-page',
      'qa-t2-child',
      'qa-t2-x',
    ];
    const tenant1 = [
      'qa-collide-action',
      'qa-collide-target',
      'qa-collide-tenant',
      'qa-dotted-ip',
      'qa-t1-a1',
      'qa-t1-b1',
      'qa-t1-child',
      'qa-t1-page',
    ];
    const siteIds = ['qa-collide-target', 'qa-collide-tenant', 'qa-t1-a1', 'qa-t1-child'];
    expect(await ids(read.secret)).toEqual(all);
    expect(await ids(t1.secret)).toEqual(tenant1);
    expect(await ids(site.secret)).toEqual(siteIds);
    expect(await ids(bookings.secret)).toEqual(['qa-collide-action', 'qa-collide-target', 'qa-collide-tenant', 'qa-t1-a1', 'qa-t1-b1']);
    // decision (#180): whitespace-padded ids are their trimmed stored id — a scope shows exactly what the console shows
    // for that stored id (tenant page, tenant:t1 filter), never more. Recorded here so it is a decision, not an accident.
    const consoleView = await ids(read.secret, 'tenant:t1');
    expect(consoleView).toEqual(tenant1);
    for (const [secret, id] of [
      [t1.secret, 'qa-collide-tenant'],
      [site.secret, 'qa-collide-target'],
      [bookings.secret, 'qa-collide-action'],
    ] as const) {
      const detail = await v1(secret, `/events/${id}`);
      expect(detail.status, id).toBe(200);
      // The event's original document still shows the id as it was sent.
      expect(JSON.stringify((await detail.json()).payload)).toMatch(/"t1 "|"site_a "|" booking.leak"/);
    }
    // Totals count in-scope events only.
    const totals = await (await v1(t1.secret, `/events?${new URLSearchParams({ from: '2026-01-01T00:00:00Z', limit: '1' })}`)).json();
    expect(totals.total).toBe(tenant1.length);
    // #138 phase 2: with the restricted query user configured, scoped reads of this project ran as logbird_query, and
    // every one that carried a scope also bound its tenant in the row-policy setting (the database-enforced layer).
    if (queryClickhouse) {
      await clickhouse.command({ query: 'SYSTEM FLUSH LOGS' });
      const layered = await (
        await clickhouse.query({
          // query_log keeps setting values quoted ("'t1'") and the query text with parameters substituted.
          query: `SELECT user, Settings['SQL_logbird_tenant'] tenant FROM system.query_log
            WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL 30 MINUTE AND Settings['SQL_logbird_project'] IN ({p:String}, {quoted:String})`,
          query_params: { p: project.id, quoted: `'${project.id}'` },
          format: 'JSONEachRow',
        })
      ).json<{ user: string; tenant: string }>();
      expect(layered.length).toBeGreaterThan(0);
      expect(layered.every((r) => r.user === 'logbird_query')).toBe(true);
      expect(layered.some((r) => r.tenant === "'t1'")).toBe(true);
    }
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
        (await ids(site.secret, q)).every((id) => siteIds.includes(id)),
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
      // A malformed position under the right fingerprint is a 422 too, never a 500.
      [read.secret, Buffer.from(JSON.stringify(['not-a-date', 'x'])).toString('base64url')],
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
      { value: 't1', label: 'Tenant one', count: tenant1.length },
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
    // Scoped two-level facets: labels and remainders come from in-scope events only.
    const scopedGroups = await facets(t1.secret, { field: 'tenant', by: 'action', byLimit: '2' });
    expect(scopedGroups.values).toHaveLength(1);
    expect(scopedGroups.values[0]).toMatchObject({ value: 't1', label: 'Tenant one', count: tenant1.length });
    expect(scopedGroups.values[0]?.groups).toEqual([
      { value: 'booking.created', label: 'booking.created', count: 3 },
      { value: 'auth.login', label: 'auth.login', count: 2 },
    ]);
    expect(scopedGroups.values[0]?.groupsOtherCount).toBe(tenant1.length - 5);
    // Two target levels expand ONE target tuple: qa-t1-page has website:site_x and page:site_a, never website:site_a.
    const targetPairs = await facets(read.secret, { field: 'target', by: 'target.type', q: 'id:qa-t1-page', limit: '10' });
    expect(targetPairs.values.map((v) => [v.value, v.groups?.map((g) => g.value)]).sort()).toEqual([
      ['site_a', ['page']],
      ['site_x', ['website']],
    ]);
    // Any query field can be faceted (#140), e.g. the actor email for an unmasked reader.
    expect((await facets(t1.secret, { field: 'actor.email' })).values.map((v) => v.value)).toContain('Lina@example.invalid');

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
      `/facets?${new URLSearchParams({ field: 'actor.email' })}`,
      `/facets?${new URLSearchParams({ field: 'tenant', by: 'actor.email' })}`,
      `/export?${new URLSearchParams({ format: 'csv', q: 'ip:203.0.113.7' })}`,
      // The literal "context.ip" attribute path is masked like the field itself, in filters and in both facet levels.
      `/events?${new URLSearchParams({ q: 'attr.context.ip:198.51.*' })}`,
      `/events?${new URLSearchParams({ q: 'context.ip:*' })}`,
      `/facets?${new URLSearchParams({ field: 'attr.context.ip' })}`,
      `/facets?${new URLSearchParams({ field: 'tenant', by: 'attributes.context.ip' })}`,
    ]) {
      const r = await v1(masked.secret, path);
      expect(r.status, path).toBe(422);
      expect((await r.json()).error, path).toMatchObject({ code: 'invalid_query', details: { reason: 'not_allowed' } });
    }
    expect(JSON.stringify(await (await v1(masked.secret, '/events/qa-dotted-ip')).json())).not.toContain('198.51.100.9');
    // Unmasked readers still facet on that attribute.
    expect((await facets(t1.secret, { field: 'attr.context.ip' })).values.map((v) => v.value)).toContain('198.51.100.9');
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
    expect((await mint('lbv1.not.valid', { scope: { tenantId: 't1' } })).status).toBe(401);
    expect((await mint(result.ingestKey.secret, { scope: { tenantId: 't1' } })).status).toBe(401);

    expect(await ids(token.token)).toEqual(siteIds);
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

    // HEAD must not start an export: 405 before admission, so no lease and no export.requested record.
    // Also without the required format (405 comes before validation), and on the console route.
    for (const path of ['/v1/export', `/v1/export?${new URLSearchParams({ format: 'csv' })}`]) {
      const head = await app.request(path, { method: 'HEAD', headers: { Authorization: `Bearer ${token.token}` } });
      expect(head.status, path).toBe(405);
      expect(head.headers.get('allow')).toBe('GET');
    }
    expect((await app.request(`/api/projects/${project.id}/export`, { method: 'HEAD', headers: { cookie: ownerCookie } })).status).toBe(405);
    expect(await prisma.exportLease.count({ where: { userId: `api_key:${read.key.id}` } })).toBe(0);
    // Export with a viewer token: only in-scope rows; audited with the key as actor and the tenant/token recorded.
    const exported = await v1(token.token, `/export?${new URLSearchParams({ format: 'jsonl', from: '2026-01-01T00:00:00Z' })}`);
    expect(exported.status).toBe(200);
    const exportId = exported.headers.get('x-logbird-export-id');
    expect(exported.headers.get('x-logbird-export-schema')).toMatch(/^jsonl\//);
    const lines = (await exported.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: string });
    expect(lines.map((e) => e.id).sort()).toEqual(siteIds);
    const csv = await (await v1(masked.secret, `/export?${new URLSearchParams({ format: 'csv', from: '2026-01-01T00:00:00Z' })}`)).text();
    // Row ids only (qa-t1-child's own parentEventId legitimately names its out-of-scope parent).
    expect(
      csv
        .trim()
        .split('\n')
        .slice(1)
        .map((row) => row.split(',')[0])
        .sort(),
    ).toEqual(tenant1.map((id) => `"${id}"`));
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
    expect(completed.metadata.export.rows).toBe(siteIds.length);

    // Evidence export with a scoped (unmasked) key across export page boundaries (200 rows per page): every in-scope
    // row exactly once, original payload text unchanged (19-digit number kept), nothing from other tenants.
    const bulkEvents = Array.from({ length: 230 }, (_, n) => ({
      id: `qa-bulk-${String(n).padStart(3, '0')}`,
      occurredAt: ts(12),
      action: 'booking.created',
      tenant: { id: 'tbulk' },
      metadata: { big: 'BIG', n },
    }));
    const bulkIngest = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${result.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body: `{"events":[${bulkEvents.map((e) => JSON.stringify(e).replace('"big":"BIG"', '"big":1234567890123456789')).join(',')}]}`,
    });
    expect((await bulkIngest.json()).accepted).toBe(230);
    const bulk = await createKey({ name: 'Bulk tenant', kind: 'scoped-read', scope: { tenantId: 'tbulk' } });
    const evidenceBulk = await v1(bulk.secret, `/export?${new URLSearchParams({ format: 'jsonl-evidence', from: '2026-01-01T00:00:00Z' })}`);
    expect(evidenceBulk.status).toBe(200);
    const evidenceLines = (await evidenceBulk.text()).trim().split('\n');
    const evidenceIds = evidenceLines.map((line) => (JSON.parse(line) as { event: { id: string } }).event.id);
    expect(evidenceIds).toHaveLength(230);
    expect(new Set(evidenceIds).size).toBe(230);
    expect(evidenceIds.every((id) => id.startsWith('qa-bulk-'))).toBe(true);
    // The original payload rides along unchanged (exact 19-digit numbers depend on the ingest fix in #168).
    for (const line of evidenceLines) {
      const row = JSON.parse(line) as { event: { id: string }; payload: { id: string; tenant: { id: string }; metadata: { n: number } } };
      expect(row.payload.id).toBe(row.event.id);
      expect(row.payload.tenant.id).toBe('tbulk');
      expect(row.event.id).toBe(`qa-bulk-${String(row.payload.metadata.n).padStart(3, '0')}`);
    }

    // Attribute facets count JSON-array text per element. Attributes are stored as text, so a real array and a string
    // that looks like one are counted the same way, and an array whose stored text is cut at 2048 bytes is no longer
    // valid JSON and counts as one value (documented guarantee).
    const tagEvents = [
      { id: 'qa-tags-array', tags: ['red', 'blue'] },
      { id: 'qa-tags-string', tags: '["red","blue"]' },
      { id: 'qa-tags-plain', tags: 'red' },
      { id: 'qa-tags-padded', tags: ' \t["green","red"]' },
      { id: 'qa-tags-long', tags: Array.from({ length: 300 }, (_, n) => `long-${n}`) },
    ].map((e) => ({ id: e.id, occurredAt: ts(14), action: 'booking.created', tenant: { id: 'tfacet' }, metadata: { tags: e.tags } }));
    expect(
      (
        await (
          await app.request('/v1/events', {
            method: 'POST',
            headers: { Authorization: `Bearer ${result.ingestKey.secret}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ events: tagEvents }),
          })
        ).json()
      ).accepted,
    ).toBe(5);
    const facetKey = await createKey({ name: 'Facet tenant', kind: 'scoped-read', scope: { tenantId: 'tfacet' } });
    const tags = await facets(facetKey.secret, { field: 'attr.metadata.tags', limit: '100' });
    const tagCount = new Map(tags.values.map((v) => [v.value, v.count]));
    expect(tagCount.get('red')).toBe(4);
    expect(tagCount.get('green')).toBe(1);
    expect(tagCount.get('blue')).toBe(2);
    expect([...tagCount.keys()].some((v) => v.startsWith('long-'))).toBe(false); // the cut array is one opaque value
    expect([...tagCount.entries()].filter(([v]) => v.startsWith('["long-0"')).map(([, n]) => n)).toEqual([1]);

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
    expect(await ids(replacement.secret)).toEqual(siteIds);
    const listed = (await (await console_(ownerCookie, keysPath)).json()).data.map((k: unknown) => apiKeySchema.parse(k));
    expect(listed.find((k: { id: string }) => k.id === t1.key.id)).toMatchObject({ kind: 'scoped-read', scope: { tenantId: 't1' } });
    await prisma.apiKey.update({ where: { id: t1.key.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await v1(t1.secret, '/events')).status).toBe(401);
    const expiredRoll = await console_(ownerCookie, `${keysPath}/${t1.key.id}/roll`, 'POST');
    expect(expiredRoll.status).toBe(409);
    expect((await expiredRoll.json()).error.code).toBe('key_expired');
    expect((await console_(ownerCookie, `${keysPath}/${t1.key.id}/roll`, 'POST', { expiresAt: later })).status).toBe(201);

    // Numeric tenant ids (rule from #174/#184): a numeric identifier is stored as the plain decimal text of its exact
    // value (42, 42.0 and 4.2e1 are stored as "42"); a string identifier is stored exactly as sent. A scope written as
    // "42" therefore matches the number 42 in any spelling and the string "42", not the string "42.0". Before that
    // ingest change numbers are not stored as ids at all, so no scope sees them; the assertions follow what is stored.
    const numericBody = `{"events":[${[
      ['qa-num-42', '42'],
      ['qa-num-42-0', '42.0'],
      ['qa-num-exp', '4.2e1'],
      ['qa-num-string', '"42"'],
      ['qa-num-string-dot', '"42.0"'],
    ]
      .map(([id, tenant]) => `{"id":"${id}","occurredAt":"${ts(13)}","action":"booking.created","tenant":{"id":${tenant}}}`)
      .join(',')}]}`;
    const numeric = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${result.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body: numericBody,
    });
    expect((await numeric.json()).accepted).toBe(5);
    const storedTenant = async (id: string) => (await (await v1(read.secret, `/events/${id}`)).json()).event.tenant?.id ?? '';
    const numbersStored = (await storedTenant('qa-num-42')) === '42';
    for (const id of ['qa-num-42-0', 'qa-num-exp']) expect(await storedTenant(id)).toBe(numbersStored ? '42' : '');
    const t42 = await createKey({ name: 'Numeric tenant', kind: 'scoped-read', scope: { tenantId: '42' } });
    expect(await ids(t42.secret)).toEqual(numbersStored ? ['qa-num-42', 'qa-num-42-0', 'qa-num-exp', 'qa-num-string'] : ['qa-num-string']);

    // escape: rollback — restricted keys (scope or expiry) carry 48 random characters, which releases before scoped
    // keys reject (their authenticator accepts exactly 32), so a rollback fails closed instead of widening them.
    const preScopeAuthenticator = /^(?:lb|tm)_(?:ingest|read)_[A-Za-z0-9]{32}$/;
    for (const restricted of [t1.secret, site.secret, masked.secret, replacement.secret]) {
      expect(restricted).toMatch(/^lb_read_[A-Za-z0-9]{48}$/);
      expect(preScopeAuthenticator.test(restricted)).toBe(false);
    }
    expect(preScopeAuthenticator.test(read.secret)).toBe(true); // unrestricted keys keep the old format
    const expiringIngest = await createKey({ name: 'Expiring ingest', kind: 'ingest', expiresAt: later });
    expect(preScopeAuthenticator.test(expiringIngest.secret)).toBe(false);
    // The fence is installed as migrated: an enabled BEFORE INSERT row trigger on "ApiKey" calling the fence function.
    const installed = await prisma.$queryRaw<{ enabled: string; insert: boolean; before: boolean; row: boolean; fn: string }[]>`
      SELECT t.tgenabled::text AS enabled, (t.tgtype & 4) <> 0 AS insert, (t.tgtype & 2) <> 0 AS before, (t.tgtype & 1) <> 0 AS row, p.proname AS fn
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = '"ApiKey"'::regclass AND t.tgname = 'ApiKey_roll_fence' AND NOT t.tgisinternal`;
    expect(installed).toEqual([{ enabled: 'O', insert: true, before: true, row: true, fn: 'logbird_api_key_roll_fence' }]);
    // escape: rollback — the database fence refuses a roll (as an older release would do it) that drops the scope or
    // the expiry; legitimate rolls and plain inserts are untouched.
    const oldReleaseRoll = (replaced: { id: string; kind: string }, extra: Record<string, unknown> = {}) =>
      prisma.apiKey.create({
        data: {
          projectId: project?.id ?? '',
          name: 'qa old-release roll',
          kind: replaced.kind === 'ingest' ? 'ingest' : 'read',
          hash: randomUUID(),
          prefix: 'lb_read_qa',
          replacesKeyId: replaced.id,
          ...extra,
        },
      });
    await expect(oldReleaseRoll(site.key, { expiresAt: new Date(later) })).rejects.toThrow(/logbird_api_key_roll_fence/);
    await expect(oldReleaseRoll(expiringIngest.key)).rejects.toThrow(/logbird_api_key_roll_fence/);
    await expect(oldReleaseRoll(site.key, { scope: site.key.scope ?? undefined })).rejects.toThrow(/logbird_api_key_roll_fence/);
    expect((await oldReleaseRoll(site.key, { scope: site.key.scope ?? undefined, expiresAt: new Date(later) })).id).toBeTruthy();
    expect((await oldReleaseRoll(expiringIngest.key, { expiresAt: new Date(later) })).id).toBeTruthy();
    expect((await oldReleaseRoll({ id: result.ingestKey.key.id, kind: 'ingest' })).id).toBeTruthy();
    expect(
      (await prisma.apiKey.create({ data: { projectId: project.id, name: 'qa plain', kind: 'read', hash: randomUUID(), prefix: 'lb_read_qa' } })).id,
    ).toBeTruthy();

    // Revocation reaches tokens within the 30 s key cache: still cached right after, refused once the cache refreshes.
    clearTokenKeyCache(); // start the 30 s window now, so the timing below is deterministic
    expect((await v1(token.token, '/events')).status).toBe(200); // warms the cache for this key
    expect((await console_(ownerCookie, `${keysPath}/${read.key.id}`, 'DELETE')).status).toBe(204);
    expect((await v1(read.secret, '/events')).status).toBe(401);
    expect((await v1(token.token, '/events')).status).toBe(200); // documented ≤ 30 s window
    expect((await tokenKey(read.key.id, Date.now() + 29_000))?.revokedAt).toBeNull();
    expect((await tokenKey(read.key.id, Date.now() + 31_000))?.revokedAt).not.toBeNull(); // the deadline refreshes it
    expect((await v1(token.token, '/events')).status).toBe(401);

    // Minting refuses oversized bodies before parsing, and scopes whose token would exceed the verifier's budget.
    const oversized = await v1(bulk.secret, '/viewer-tokens', { method: 'POST', body: { scope: { tenantId: 'tbulk' }, pad: 'x'.repeat(20_000) } });
    expect(oversized.status).toBe(413);
    const huge = await createKey({ name: 'Huge scope', kind: 'read' });
    const wide = await v1(huge.secret, '/viewer-tokens', {
      method: 'POST',
      body: { scope: { tenantId: 'tbulk', actionPrefixes: Array.from({ length: 20 }, (_, n) => `${'€'.repeat(185)}${n}`) } },
    });
    expect(wide.status).toBe(422);
    // Ingest keys cannot read; the ingest path still works for ingest keys only.
    expect((await v1(result.ingestKey.secret, '/events')).status).toBe(401);
  } finally {
    clearTokenKeyCache();
    // Every cleanup step runs even if an earlier one fails; failures are reported after all of them ran.
    const failures: unknown[] = [];
    const step = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        failures.push(error);
      }
    };
    if (project) {
      const { id, slug } = project;
      await step(async () => {
        const deleted = await console_(ownerCookie, `/api/projects/${id}?confirm=${slug}`, 'DELETE');
        if (deleted.status !== 204) throw new Error(`project delete answered ${deleted.status}`);
      });
    }
    if (organizationId) {
      await step(() => prisma.exportLease.deleteMany({ where: { workspaceId: organizationId } }));
      await step(() => prisma.auditOutbox.deleteMany({ where: { stream: `ws:${organizationId}` } }));
      await step(() => purgeProject(clickhouse, `ws:${organizationId}`));
      await step(() => prisma.organization.delete({ where: { id: organizationId } }));
    }
    await step(() => prisma.user.deleteMany({ where: { id: { in: users } } }));
    if (failures.length) console.error(JSON.stringify({ event: 'qa.scoped_read.cleanup_failed', failures: failures.map(String) }));
    expect(failures).toEqual([]);
  }
}, 360_000);
