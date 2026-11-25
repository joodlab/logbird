import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fieldMaskKey, maskedEmail, purgeProject, read } from '@logbird/clickhouse';
import { createApiKeyResponseSchema, createProjectResponseSchema, facetResponseSchema } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { webhookCursorClock } from '@logbird/database/webhooks';
import { expect, it } from 'vitest';
import { discoverWebhookDeliveries } from '../../worker/src/webhook-discovery';
import { app } from './app';
import { clickhouse } from './clickhouse';
import { env } from './env';

/**
 * `changes.before`, `changes.after` and `impersonator.name` are query fields over the stored columns, and any other
 * `changes.*` key is refused instead of silently matching nothing. Change values match their stored text (any element
 * of the event's changes); the impersonator's name obeys the actor_email mask like the actor's. Search, facets and
 * webhook filters, through the real server on real ClickHouse and Postgres.
 */
const MAILPIT = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
const BIG_VALUE = `long:${'x'.repeat(150 * 1024)}`;

it('change values and the impersonator name are query fields; unknown changes.* keys are refused (real services)', async () => {
  const users: string[] = [];
  const mailIds: string[] = [];
  let organizationId = '';
  let project: { id: string; slug: string } | undefined;
  let ownerCookie = '';
  let passed = false;
  let cleanupError: Error | undefined;
  const console_ = (cookie: string, path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const v1 = (bearer: string, path: string) =>
    app.request(
      `/v1${path}`,
      { headers: { Authorization: `Bearer ${bearer}`, 'User-Agent': 'change-values-query-test' } },
      { incoming: { socket: { remoteAddress: '203.0.113.93' } } },
    );
  async function login() {
    const email = `qa-change-values-${randomUUID()}@example.invalid`;
    expect((await console_('', '/api/auth/email-otp/send-verification-otp', 'POST', { email, type: 'sign-in' })).status).toBe(200);
    let message: { ID: string } | undefined;
    for (let attempt = 0; !message; attempt++) {
      if (attempt === 30) throw new Error('Sign-in code never reached Mailpit');
      if (attempt) await delay(500);
      const mailbox = await (await fetch(`${MAILPIT}/api/v1/messages?limit=100`)).json();
      message = mailbox.messages.find((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === email));
    }
    mailIds.push(message.ID);
    const content = await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json();
    const response = await console_('', '/api/auth/sign-in/email-otp', 'POST', { email, otp: content.Text.match(/\b\d{6}\b/)[0] });
    expect(response.status).toBe(200);
    users.push((await response.json()).user.id);
    return response.headers
      .getSetCookie()
      .map((s) => s.split(';')[0])
      .join('; ');
  }
  try {
    ownerCookie = await login();
    const org = await console_(ownerCookie, '/api/auth/organization/create', 'POST', {
      name: 'QA change values',
      slug: `qa-change-values-${randomUUID()}`,
    });
    expect(org.status).toBe(200);
    organizationId = (await org.json()).id;
    const created = await console_(ownerCookie, '/api/projects', 'POST', { name: 'QA change values fixture' });
    expect(created.status).toBe(201);
    const result = createProjectResponseSchema.parse(await created.json());
    project = result.project;
    const projectId = project.id;
    const createKey = async (body: Record<string, unknown>) => {
      const r = await console_(ownerCookie, `/api/projects/${projectId}/keys`, 'POST', body);
      expect(r.status, await r.clone().text()).toBe(201);
      return createApiKeyResponseSchema.parse(await r.json());
    };
    const reader = await createKey({ name: 'Read', kind: 'read' });
    const masked = await createKey({ name: 'Masked t1', kind: 'scoped-read', scope: { tenantId: 't1', mask: ['actor_email'] } });
    const masked3 = await createKey({ name: 'Masked t3', kind: 'scoped-read', scope: { tenantId: 't3', mask: ['actor_email'] } });
    const plain = await createKey({ name: 'Plain t1', kind: 'scoped-read', scope: { tenantId: 't1' } });

    // Webhook filters share the language: an endpoint per filter, masked and unmasked, scanning from before the ingest.
    const createHook = async (filterQuery: string, mask?: string[]) =>
      console_(ownerCookie, `/api/projects/${projectId}/webhooks`, 'POST', {
        url: 'https://8.8.8.8/qa-change-values',
        filterQuery,
        scope: { tenantId: 't1', ...(mask ? { mask } : {}) },
      });
    const HOOKS = [
      { filter: 'changes.after:PUBLISHED', rows: ['c1', 'c3'] },
      { filter: 'changes.before:DRAFT changes.field:status', rows: ['c1', 'c3'] },
      { filter: 'impersonator.name:"rita@example.invalid"', rows: ['i2'] },
      { filter: 'impersonator.name:"rita@example.invalid"', rows: [], mask: ['actor_email'] },
    ];
    const hooks: { filter: string; rows: string[]; id: string }[] = [];
    for (const hook of HOOKS) {
      const r = await createHook(hook.filter, hook.mask);
      expect(r.status, await r.clone().text()).toBe(201);
      hooks.push({ ...hook, id: (await r.json()).endpoint.id });
    }
    // A stored filter that later stops compiling: created valid, then rewritten in the database to an unknown key.
    const staleHook = await createHook('changes.after:PUBLISHED');
    expect(staleHook.status).toBe(201);
    const staleId = (await staleHook.json()).endpoint.id as string;
    const refusedHook = await createHook('changes.to:PUBLISHED');
    expect(refusedHook.status).toBe(422);
    expect((await refusedHook.json()).error).toMatchObject({ code: 'invalid_query', details: { reason: 'unknown_field' } });
    const cursorFrom = new Date(+(await webhookCursorClock(prisma)).now - 60_000);
    // Loopback, never a third party: a delivery worker sharing this database could otherwise claim the queued rows.
    for (const id of [...hooks.map((h) => h.id), staleId])
      await prisma.webhookEndpoint.update({
        where: { id },
        data: { createdAt: cursorFrom, cursorReceivedAt: cursorFrom, url: 'http://127.0.0.1:9/qa-change-values' },
      });
    const patched = await console_(ownerCookie, `/api/projects/${projectId}/webhooks/${hooks[0]?.id}`, 'PATCH', { filterQuery: 'changes.to:x' });
    expect(patched.status, await patched.clone().text()).toBe(422);
    expect((await patched.json()).error).toMatchObject({ code: 'invalid_query', details: { reason: 'unknown_field' } });
    await prisma.webhookEndpoint.update({ where: { id: staleId }, data: { filterQuery: 'changes.to:PUBLISHED' } });

    const ts = (n: number) => new Date(Date.now() - (60 - n) * 60_000).toISOString();
    const tenant = { id: 't1' };
    const actor = { type: 'user', id: 'u1', name: 'Sami Writer' };
    const events = [
      {
        id: 'c1',
        occurredAt: ts(1),
        action: 'article.status_changed',
        tenant,
        actor,
        changes: [{ field: 'status', before: 'DRAFT', after: 'PUBLISHED' }],
      },
      {
        id: 'c2',
        occurredAt: ts(2),
        action: 'article.updated',
        tenant,
        actor,
        changes: [
          { field: 'status', before: 'PUBLISHED', after: 'ARCHIVED' },
          { field: 'title', before: 'Old', after: 'New' },
        ],
      },
      // Status went DRAFT → REVIEW while another field became PUBLISHED: the arrays are checked independently.
      {
        id: 'c3',
        occurredAt: ts(3),
        action: 'article.updated',
        tenant,
        actor,
        changes: [
          { field: 'status', before: 'DRAFT', after: 'REVIEW' },
          { field: 'label', before: '', after: 'PUBLISHED' },
        ],
      },
      // Value kinds: numbers (12.50, and a 20-digit integer a double cannot hold), null, absent, booleans, an array, an object.
      {
        id: 'c4',
        occurredAt: ts(4),
        action: 'article.updated',
        tenant,
        actor,
        changes: [
          { field: 'price', before: 10, after: 'RAW_DECIMAL' },
          { field: 'note', before: null },
          { field: 'flag', before: false, after: true },
          { field: 'tags', before: ['a'], after: ['a', 'b'] },
          { field: 'meta', after: { k: 1 } },
          { field: 'big', after: 'RAW_BIG' },
        ],
      },
      { id: 'i1', occurredAt: ts(5), action: 'article.updated', tenant, actor, impersonator: { id: 'sup_rita', name: 'Rita Support' } },
      // A literal top-level dotted key (an attribute, reachable as attr.changes.to) and the same after-value twice.
      {
        id: 'l1',
        occurredAt: ts(7),
        action: 'article.updated',
        tenant,
        actor,
        'changes.to': 'PUBLISHED',
        changes: [
          { field: 'a', before: 'X', after: 'SAME' },
          { field: 'b', before: 'Y', after: 'SAME' },
        ],
      },
      // Another tenant: a t1 scope must never see it.
      {
        id: 'big1',
        occurredAt: ts(9),
        action: 'article.updated',
        tenant,
        actor,
        // A 150 KB value: a second facet level must not send it back to ClickHouse as a URL parameter.
        changes: [{ field: 'body', before: 'v1', after: BIG_VALUE }],
      },
      // An impersonator sent with a name and no id: found by impersonator.name, shown as no impersonator (documented).
      { id: 'n1', occurredAt: ts(10), action: 'article.viewed', tenant, actor, impersonator: { name: 'Nameless Support' } },
      // Tenant t3: 100 distinct 900-character after-values, so a second facet level carries about 90 KB of parents.
      ...Array.from({ length: 100 }, (_, n) => ({
        id: `m${n}`,
        occurredAt: ts(11),
        action: 'article.updated',
        tenant: { id: 't3' },
        actor,
        changes: [{ field: 'summary', before: '', after: `${String(n).padStart(3, '0')}${'s'.repeat(897)}` }],
      })),
      {
        id: 'o1',
        occurredAt: ts(8),
        action: 'article.status_changed',
        tenant: { id: 't2' },
        actor,
        changes: [{ field: 'status', before: 'DRAFT', after: 'PUBLISHED' }],
      },
      {
        id: 'i2',
        occurredAt: ts(6),
        action: 'article.updated',
        tenant,
        actor,
        impersonator: { id: 'sup_x', name: 'rita@example.invalid', email: 'rita@example.invalid' },
      },
    ];
    const body = JSON.stringify({ events }).replace('"RAW_DECIMAL"', '12.50').replace('"RAW_BIG"', '12345678901234567890');
    const ingested = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${result.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body,
    });
    expect(ingested.status, await ingested.clone().text()).toBe(202);
    const ingestedAt = (await webhookCursorClock(prisma)).now;
    const from = '2026-01-01T00:00:00Z';
    const get = async (bearer: string, path: string) => {
      const r = await v1(bearer, path);
      const text = await r.text();
      return { status: r.status, text, body: JSON.parse(text || 'null') };
    };
    const ids = async (bearer: string, q: string) => {
      const r = await get(bearer, `/events?${new URLSearchParams({ q, from, limit: '100' })}`);
      expect(r.status, `${q}: ${r.text}`).toBe(200);
      return (r.body.data as { id: string }[]).map((e) => e.id).sort();
    };

    // The stored text forms the values match (what the docs promise), read back through detail.
    const c4 = await get(reader.secret, '/events/c4');
    expect(c4.status).toBe(200);
    expect(c4.body.event.changes).toEqual([
      { field: 'price', before: '10', after: '12.5' },
      { field: 'note', before: 'null', after: '' },
      { field: 'flag', before: 'false', after: 'true' },
      { field: 'tags', before: '["a"]', after: '["a","b"]' },
      { field: 'meta', before: '', after: '{"k":1}' },
      { field: 'big', before: '', after: '12345678901234567890' },
    ]);

    const PROBES: { q: string; rows: string[] }[] = [
      { q: 'changes.after:PUBLISHED', rows: ['c1', 'c3'] },
      { q: 'changes.before:DRAFT', rows: ['c1', 'c3'] },
      { q: 'changes.before:PUBLISHED', rows: ['c2'] },
      { q: 'changes.after:PUB*', rows: ['c1', 'c3'] },
      { q: 'changes.after:/ARCH.*/', rows: ['c2'] },
      { q: 'changes.after:(ARCHIVED OR REVIEW)', rows: ['c2', 'c3'] },
      { q: '-changes.after:PUBLISHED changes.field:status', rows: ['c2'] },
      // The documented limit: independent arrays, so c3 (status → REVIEW, label → PUBLISHED) matches too.
      { q: 'changes.field:status changes.after:PUBLISHED', rows: ['c1', 'c3'] },
      // A number a double holds exactly is written in JavaScript's shortest form: 12.50 is stored as 12.5.
      { q: 'changes.after:12.5', rows: ['c4'] },
      { q: 'changes.after:"12.50"', rows: [] },
      { q: 'changes.before:10', rows: ['c4'] },
      { q: 'changes.after:12345678901234567890', rows: ['c4'] },
      { q: 'changes.before:null', rows: ['c4'] },
      { q: 'changes.after:""', rows: ['c4'] },
      { q: 'changes.before:""', rows: ['c3', 'c4'] },
      { q: 'changes.after:true', rows: ['c4'] },
      { q: 'changes.after:"[\\"a\\",\\"b\\"]"', rows: ['c4'] },
      { q: 'changes.after:"{\\"k\\":1}"', rows: ['c4'] },
      { q: '_exists_:changes.before', rows: ['big1', 'c1', 'c2', 'c3', 'c4', 'l1'] },
      { q: 'changes.after:SAME', rows: ['l1'] },
      { q: 'impersonator.name:"Rita Support"', rows: ['i1'] },
      { q: 'impersonator.name:Rita*', rows: ['i1'] },
      { q: 'impersonator.name:"rita@example.invalid"', rows: ['i2'] },
      { q: '_exists_:impersonator.name', rows: ['i1', 'i2', 'n1'] },
    ];
    // The t1 scoped key: exactly the fixture rows. The project read key also sees the t2 event.
    for (const { q, rows } of PROBES) expect(await ids(plain.secret, q), q).toEqual(rows);
    expect(await ids(reader.secret, 'changes.after:PUBLISHED')).toEqual(['c1', 'c3', 'o1']);
    expect(await ids(reader.secret, 'changes.field:status changes.before:DRAFT')).toEqual(['c1', 'c3', 'o1']);
    // impersonator.id is the impersonator id; letter case of the changes namespace does not bypass the refusal.
    expect(await ids(plain.secret, 'impersonator.id:sup_rita')).toEqual(['i1']);
    for (const q of ['Changes.field:status', 'changes.after:>*', 'impersonator.type:>*', 'attr.changes.to:<=*'])
      expect((await get(plain.secret, `/events?${new URLSearchParams({ q, from })}`)).status, q).toBe(422);

    // Unknown changes.* keys: 422 invalid_query (unknown_field) naming the valid fields, in search, facets and export.
    for (const q of ['changes.to:PUBLISHED', 'changes.value:x', 'changes:x', '_exists_:changes.new']) {
      for (const path of [
        `/events?${new URLSearchParams({ q, from })}`,
        `/facets?${new URLSearchParams({ field: 'action', q, from })}`,
        `/export?${new URLSearchParams({ format: 'csv', q, from })}`,
      ]) {
        const r = await get(reader.secret, path);
        expect(r.status, path).toBe(422);
        expect(r.body.error, path).toMatchObject({ code: 'invalid_query', details: { lang: 'query', reason: 'unknown_field' } });
        expect(r.body.error.details.hint, path).toMatch(/changes\.field, changes\.before or changes\.after/);
      }
    }
    // An explicit attribute lookup stays an attribute lookup.
    expect(await ids(reader.secret, 'attr.changes.to:PUBLISHED')).toEqual(['l1']);

    // Facets over the arrays count each element.
    const after = await get(plain.secret, `/facets?${new URLSearchParams({ field: 'changes.after', from, limit: '20' })}`);
    expect(after.status, after.text).toBe(200);
    const counts = Object.fromEntries(facetResponseSchema.parse(after.body).values.map((v) => [v.value, v.count]));
    // Counts are per element: l1's two changes to SAME count twice (documented).
    expect(counts).toMatchObject({ PUBLISHED: 2, ARCHIVED: 1, REVIEW: 1, New: 1, true: 1, '12.5': 1, SAME: 2 });
    // Two change levels pair each field with its own value (one zipped expansion), never with another field's.
    const pairs = await get(
      plain.secret,
      `/facets?${new URLSearchParams({ field: 'changes.field', by: 'changes.after', from, limit: '50', byLimit: '20' })}`,
    );
    expect(pairs.status, pairs.text).toBe(200);
    const grouped = Object.fromEntries(
      facetResponseSchema.parse(pairs.body).values.map((v) => [v.value, Object.fromEntries((v.groups ?? []).map((g) => [g.value, g.count]))]),
    );
    expect(grouped.status).toEqual({ PUBLISHED: 1, ARCHIVED: 1, REVIEW: 1 });
    expect(grouped.label).toEqual({ PUBLISHED: 1 });
    expect(grouped.title).toEqual({ New: 1 });
    // A very long parent value at either level and masked or not: the second level still answers (parents travel as digests).
    for (const bearer of [plain.secret, masked.secret]) {
      for (const query of [
        { field: 'changes.after', by: 'changes.field' },
        { field: 'changes.after', by: 'action' },
      ]) {
        const r = await get(bearer, `/facets?${new URLSearchParams({ ...query, from, limit: '50', q: 'id:big1' })}`);
        expect(r.status, `${JSON.stringify(query)} ${r.text.slice(0, 200)}`).toBe(200);
        const [value] = facetResponseSchema.parse(r.body).values;
        expect(value?.value.length).toBe(BIG_VALUE.length);
        expect(value?.groups?.map((g) => [g.value, g.count])).toEqual([[query.by === 'action' ? 'article.updated' : 'body', 1]]);
      }
    }
    // Many medium-length parents (about 90 KB of them) at the second level, masked and unmasked.
    for (const bearer of [reader.secret, masked3.secret]) {
      const r = await get(
        bearer,
        `/facets?${new URLSearchParams({ field: 'changes.after', by: 'changes.field', from, limit: '100', q: 'tenant:t3' })}`,
      );
      expect(r.status, r.text.slice(0, 200)).toBe(200);
      const values = facetResponseSchema.parse(r.body).values;
      expect(values).toHaveLength(100);
      for (const v of values) expect(v.groups?.map((g) => [g.value, g.count])).toEqual([['summary', 1]]);
    }
    // Suggestions refuse a changes key the server refuses; the explicit attribute spelling still works.
    const suggest = (field: string) => console_(ownerCookie, `/api/projects/${projectId}/suggest?${new URLSearchParams({ field, from })}`);
    const refusedSuggest = await suggest('changes.to');
    expect(refusedSuggest.status).toBe(422);
    expect((await refusedSuggest.json()).error).toMatchObject({ code: 'invalid_query', details: { reason: 'unknown_field' } });
    const literalSuggest = await suggest('attr.changes.to');
    expect(literalSuggest.status, await literalSuggest.clone().text()).toBe(200);
    expect((await literalSuggest.json()).values.map((v: { value: string }) => v.value)).toContain('PUBLISHED');
    // The alias gets the same labels as the field, at both levels.
    for (const bearer of [plain.secret, masked.secret]) {
      const facet = async (query: Record<string, string>) =>
        facetResponseSchema.parse((await get(bearer, `/facets?${new URLSearchParams({ ...query, from, limit: '50' })}`)).body).values;
      expect(await facet({ field: 'impersonator.id' })).toEqual(await facet({ field: 'impersonator' }));
      expect(await facet({ field: 'action', by: 'impersonator.id' })).toEqual(await facet({ field: 'action', by: 'impersonator' }));
    }
    // A name-only impersonator: impersonator.name finds the event, whose projection shows no impersonator (id required).
    expect(await ids(plain.secret, 'impersonator.name:"Nameless Support"')).toEqual(['n1']);
    expect((await get(plain.secret, '/events/n1')).body.event.impersonator).toBeNull();

    // Under the actor_email mask: change values filter as usual; an address-carrying impersonator name reads as empty
    // in filters and shows as the address's pseudonym in facets, while an ordinary name still filters.
    expect(await ids(masked.secret, 'changes.after:PUBLISHED')).toEqual(['c1', 'c3']);
    expect(await ids(masked.secret, 'impersonator.name:"Rita Support"')).toEqual(['i1']);
    for (const q of ['impersonator.name:"rita@example.invalid"', 'impersonator.name:rita*', 'impersonator.name:/.*@.*/'])
      expect(await ids(masked.secret, q), q).toEqual([]);
    expect(await ids(plain.secret, 'impersonator.name:/.*@.*/')).toEqual(['i2']);
    const pseudonym = maskedEmail(projectId, 'rita@example.invalid', fieldMaskKey(env.BETTER_AUTH_SECRET), 'impersonator');
    const names = await get(masked.secret, `/facets?${new URLSearchParams({ field: 'impersonator.name', from })}`);
    expect(names.status, names.text).toBe(200);
    expect(names.text).not.toMatch(/rita@example/i);
    expect(Object.fromEntries(facetResponseSchema.parse(names.body).values.map((v) => [v.value, v.count]))).toMatchObject({
      'Rita Support': 1,
      [pseudonym]: 1,
    });

    // Webhook discovery runs the same fields (masked endpoints through the same rewrite).
    const discovered = async (id: string) => {
      for (let attempt = 0; ; attempt++) {
        const endpoint = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } });
        if (endpoint.cursorReceivedAt > ingestedAt) break;
        if (attempt === 120) throw new Error(`Endpoint ${id} did not scan past the ingest`);
        await discoverWebhookDeliveries(clickhouse, endpoint, { now: (await webhookCursorClock(prisma)).now, rollout: new Date(+cursorFrom - 1) });
        await delay(1000);
      }
      return (await prisma.webhookDelivery.findMany({ where: { endpointId: id }, select: { eventId: true } })).map((d) => d.eventId).sort();
    };
    for (const hook of hooks) expect(await discovered(hook.id), `${hook.filter} ${hook.id}`).toEqual(hook.rows);
    // The stored filter that no longer compiles: discovery holds the endpoint and leaves its cursor where it was.
    await discoverWebhookDeliveries(clickhouse, await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: staleId } }), {
      now: (await webhookCursorClock(prisma)).now,
      rollout: new Date(+cursorFrom - 1),
    });
    const held = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: staleId } });
    expect([held.filterReviewRequired, held.filterReviewReason, +held.cursorReceivedAt]).toEqual([true, 'invalid_filter', +cursorFrom]);
    expect(await prisma.webhookDelivery.count({ where: { endpointId: staleId } })).toBe(0);
    await prisma.webhookEndpoint.updateMany({ where: { projectId }, data: { enabled: false } });
    passed = true;
  } finally {
    const failures: unknown[] = [];
    const step = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return true;
      } catch (error) {
        failures.push(error);
        return false;
      }
    };
    let eventsGone = true;
    if (project) {
      const { id, slug } = project;
      await step(async () => {
        const deleted = await console_(ownerCookie, `/api/projects/${id}?confirm=${slug}`, 'DELETE');
        if (deleted.status !== 204) throw new Error(`project delete answered ${deleted.status}`);
      });
      eventsGone = await step(async () => {
        const remaining = async () =>
          Number((await read<{ n: string }>(clickhouse, 'SELECT count() n FROM events WHERE project_id = {p:String}', { p: id }))[0]?.n);
        if ((await remaining()) > 0) await purgeProject(clickhouse, id);
        if ((await remaining()) > 0) throw new Error(`events of fixture project ${id} remain`);
      });
    }
    if (organizationId) {
      await step(() => prisma.auditOutbox.deleteMany({ where: { stream: `ws:${organizationId}` } }));
      eventsGone = (await step(() => purgeProject(clickhouse, `ws:${organizationId}`))) && eventsGone;
      if (eventsGone) await step(() => prisma.organization.delete({ where: { id: organizationId } }));
    }
    if (eventsGone) await step(() => prisma.user.deleteMany({ where: { id: { in: users } } }));
    if (mailIds.length)
      await step(() =>
        fetch(`${MAILPIT}/api/v1/messages`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ IDs: mailIds }),
        }).then((r) => {
          if (!r.ok) throw new Error(`Mailpit cleanup answered ${r.status}`);
        }),
      );
    if (failures.length) {
      const error = new AggregateError(failures, `change-values-query cleanup failed: ${failures.map(String).join('; ')}`);
      if (passed) cleanupError = error;
      else console.error(JSON.stringify({ event: 'qa.change_values_query.cleanup_failed', failures: failures.map(String) }));
    }
  }
  if (cleanupError) throw cleanupError;
}, 600_000);
