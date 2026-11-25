import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fieldMaskKey, maskedEmail, purgeProject, read } from '@logbird/clickhouse';
import { createApiKeyResponseSchema, createProjectResponseSchema, facetResponseSchema } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { webhookCursorClock, webhookSecretKey } from '@logbird/database/webhooks';
import { expect, it } from 'vitest';
import { deliverWebhooks } from '../../worker/src/webhook-delivery';
import { discoverWebhookDeliveries } from '../../worker/src/webhook-discovery';
import { app } from './app';
import { clickhouse } from './clickhouse';
import { env } from './env';
import { clearTokenKeyCache } from './read-access';

/**
 * Under an actor_email mask, the impersonator (a support person acting as the actor) is masked like the actor: the email
 * ingest keeps as the attribute `impersonator.email` (and any path below it) shows as the pseudonym the same address has
 * as an actor email, and an impersonator name that carries an address shows as a pseudonym. For a masked scoped key and
 * a viewer token minted with that mask, the address never comes out of search results, event detail (event and
 * parents), facets (values, labels, groups), export (CSV, JSONL), or webhook bodies; filters and facets on the
 * attribute are refused (422 not_allowed), also in webhook filters. Unmasked readers see the stored values. Real
 * services.
 */
const MAILPIT = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
/** Every fixture address (and the address-carrying names) contains one of these local parts. */
const ADDRESS = /(rita|omar|solo|nadia)[\w.]*\s*@\s*example\.invalid/i;
const PSEUDONYM = /^masked:[0-9a-f]{24}$/;

it("a masked reader cannot get the impersonator's address out of any read, export, facet, filter, token or webhook (real services)", async () => {
  const users: string[] = [];
  const mailIds: string[] = [];
  let organizationId = '';
  let project: { id: string; slug: string } | undefined;
  let ownerCookie = '';
  let passed = false;
  let cleanupError: Error | undefined;
  const received: { path: string; payload: string }[] = [];
  const receiver = createServer(async (req, res) => {
    req.setEncoding('utf8');
    let payload = '';
    for await (const chunk of req) payload += chunk;
    received.push({ path: req.url ?? '', payload });
    res.writeHead(204).end();
  });
  const console_ = (cookie: string, path: string, method = 'GET', body?: unknown) =>
    app.request(path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const v1 = (bearer: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(
      `/v1${path}`,
      {
        method: init.method ?? 'GET',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'User-Agent': 'impersonator-mask-test' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
      { incoming: { socket: { remoteAddress: '203.0.113.92' } } },
    );
  async function login() {
    const email = `qa-imp-mask-${randomUUID()}@example.invalid`;
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
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    const receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    ownerCookie = await login();
    const org = await console_(ownerCookie, '/api/auth/organization/create', 'POST', {
      name: 'QA impersonator mask',
      slug: `qa-imp-mask-${randomUUID()}`,
    });
    expect(org.status).toBe(200);
    organizationId = (await org.json()).id;
    const created = await console_(ownerCookie, '/api/projects', 'POST', { name: 'QA impersonator mask fixture' });
    expect(created.status).toBe(201);
    const result = createProjectResponseSchema.parse(await created.json());
    project = result.project;
    const projectId = project.id;
    const createKey = async (body: Record<string, unknown>) => {
      const r = await console_(ownerCookie, `/api/projects/${projectId}/keys`, 'POST', body);
      expect(r.status, await r.clone().text()).toBe(201);
      return createApiKeyResponseSchema.parse(await r.json());
    };
    const masked = await createKey({ name: 'Masked t1', kind: 'scoped-read', scope: { tenantId: 't1', mask: ['actor_email'] } });
    const unmasked = await createKey({ name: 'Plain t1', kind: 'scoped-read', scope: { tenantId: 't1' } });
    const serverKey = await createKey({ name: 'Server', kind: 'read' });
    const minted = await v1(serverKey.secret, '/viewer-tokens', { method: 'POST', body: { scope: { tenantId: 't1', mask: ['actor_email'] } } });
    expect(minted.status, await minted.clone().text()).toBe(201);
    const token = (await minted.json()).token as string;

    // Webhooks: a masked and an unmasked endpoint with no filter (bodies), and filters on the attribute refused with the mask.
    const hookBody = (filterQuery: string, mask?: string[]) => ({
      url: 'https://8.8.8.8/qa-imp-mask',
      filterQuery,
      scope: { tenantId: 't1', ...(mask ? { mask } : {}) },
    });
    const createHook = async (mask?: string[]) => {
      const r = await console_(ownerCookie, `/api/projects/${projectId}/webhooks`, 'POST', hookBody('', mask));
      expect(r.status, await r.clone().text()).toBe(201);
      return (await r.json()).endpoint.id as string;
    };
    const hooks = { plain: await createHook(), masked: await createHook(['actor_email']) };
    const cursorFrom = new Date(+(await webhookCursorClock(prisma)).now - 60_000);
    for (const id of Object.values(hooks))
      await prisma.webhookEndpoint.update({
        where: { id },
        data: { createdAt: cursorFrom, cursorReceivedAt: cursorFrom, url: `${receiverUrl}/${id}` },
      });

    // Support acting as users: the address as the name (case and whitespace variants of one person), the address inside
    // the name, an address only as the name with no email, an ordinary name with an email, an email kept as an object
    // (paths below impersonator.email), and a child event whose parent is impersonated.
    const ts = (n: number) => new Date(Date.now() - (60 - n) * 60_000).toISOString();
    const tenant = { id: 't1', name: 'Tenant one' };
    const actor = { type: 'user', id: 'u1', name: 'Sami Writer' };
    const events = [
      {
        id: 'qa-imp-1',
        occurredAt: ts(1),
        action: 'article.updated',
        tenant,
        actor,
        impersonator: { id: 'sup_rita', name: 'Rita@example.invalid', email: 'Rita@example.invalid' },
        context: { operationId: 'op-imp' },
      },
      {
        id: 'qa-imp-2',
        occurredAt: ts(2),
        action: 'article.published',
        tenant,
        actor,
        impersonator: { id: 'sup_rita', name: ' RITA @ example.invalid ', email: 'rita@Example.invalid' },
        context: { operationId: 'op-imp', parentEventId: 'qa-imp-1' },
      },
      {
        id: 'qa-imp-3',
        occurredAt: ts(3),
        action: 'article.updated',
        tenant,
        actor,
        impersonator: { id: 'sup_omar', name: 'Omar Support', email: 'omar@example.invalid' },
      },
      {
        id: 'qa-imp-4',
        occurredAt: ts(4),
        action: 'article.updated',
        tenant,
        actor,
        impersonator: { id: 'sup_nadia', name: 'Nadia <nadia@example.invalid>', email: 'nadia@example.invalid' },
      },
      { id: 'qa-imp-5', occurredAt: ts(5), action: 'article.updated', tenant, actor, impersonator: { id: 'sup_solo', name: 'Solo@example.invalid' } },
      {
        id: 'qa-imp-6',
        occurredAt: ts(6),
        action: 'article.updated',
        tenant,
        actor,
        impersonator: { id: 'sup_omar', name: 'Omar Support', email: { work: 'omar.work@example.invalid' } },
      },
    ];
    const ingested = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${result.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    expect(ingested.status, await ingested.clone().text()).toBe(202);
    const ingestedAt = (await webhookCursorClock(prisma)).now;
    const from = '2026-01-01T00:00:00Z';
    const ALL = events.map((e) => e.id);
    const get = async (bearer: string, path: string) => {
      const r = await v1(bearer, path);
      const text = await r.text();
      return { status: r.status, text, body: JSON.parse(text || 'null') };
    };
    const search = async (bearer: string, q: string) => {
      const r = await get(bearer, `/events?${new URLSearchParams({ q, from, limit: '100' })}`);
      expect(r.status, `${q}: ${r.text}`).toBe(200);
      return r;
    };
    const ids = async (bearer: string, q: string) => ((await search(bearer, q)).body.data as { id: string }[]).map((e) => e.id).sort();
    const facets = async (bearer: string, query: Record<string, string>) => {
      const r = await get(bearer, `/facets?${new URLSearchParams({ from, ...query })}`);
      expect(r.status, r.text).toBe(200);
      return { text: r.text, body: facetResponseSchema.parse(r.body) };
    };
    const exported = async (bearer: string, format: string) => {
      // The previous export's admission lease is released just after its body ends: wait for it (busy only, bounded).
      let r = await v1(bearer, `/export?${new URLSearchParams({ format, from })}`);
      for (let attempt = 0; r.status === 429 && attempt < 60; attempt++) {
        expect((await r.json()).error.code, format).toBe('export_busy');
        await delay(500);
        r = await v1(bearer, `/export?${new URLSearchParams({ format, from })}`);
      }
      expect(r.status, format).toBe(200);
      return r.text();
    };

    const key = fieldMaskKey(env.BETTER_AUTH_SECRET);
    const p = {
      rita: maskedEmail(projectId, 'rita@example.invalid', key),
      omar: maskedEmail(projectId, 'omar@example.invalid', key),
      omarWork: maskedEmail(projectId, 'omar.work@example.invalid', key),
      nadia: maskedEmail(projectId, 'nadia@example.invalid', key),
      solo: maskedEmail(projectId, 'solo@example.invalid', key),
    };
    // What each event's impersonator looks like under the mask: name and the email attribute(s).
    const EXPECTED: Record<string, { name: string; attributes: Record<string, string> }> = {
      'qa-imp-1': { name: p.rita, attributes: { 'impersonator.email': p.rita } },
      'qa-imp-2': { name: p.rita, attributes: { 'impersonator.email': p.rita } },
      'qa-imp-3': { name: 'Omar Support', attributes: { 'impersonator.email': p.omar } },
      'qa-imp-4': { name: p.nadia, attributes: { 'impersonator.email': p.nadia } },
      'qa-imp-5': { name: p.solo, attributes: {} },
      'qa-imp-6': { name: 'Omar Support', attributes: { 'impersonator.email.work': p.omarWork } },
    };
    type Event = { id: string; impersonator: { id: string; name: string } | null; attributes: Record<string, string> };
    const impersonatorOf = (e: Event) => ({
      name: e.impersonator?.name,
      attributes: Object.fromEntries(Object.entries(e.attributes).filter(([k]) => k.startsWith('impersonator.email'))),
    });

    // Contrast: the unmasked scoped key sees every address, and every refused probe below selects its rows without the mask.
    const plainPage = await search(unmasked.secret, '');
    expect(plainPage.text).toMatch(ADDRESS);
    expect((plainPage.body.data as Event[]).find((e) => e.id === 'qa-imp-1')?.attributes['impersonator.email']).toBe('Rita@example.invalid');
    const REFUSED_FILTERS: { q: string; rows: string[] }[] = [
      { q: 'impersonator.email:"Rita@example.invalid"', rows: ['qa-imp-1'] },
      { q: 'attr.impersonator.email:rita*', rows: ['qa-imp-2'] },
      { q: 'attributes.impersonator.email:/.*@.*/', rows: ['qa-imp-1', 'qa-imp-2', 'qa-imp-3', 'qa-imp-4'] },
      { q: '_exists_:impersonator.email', rows: ['qa-imp-1', 'qa-imp-2', 'qa-imp-3', 'qa-imp-4'] },
      { q: 'impersonator.email:*', rows: ['qa-imp-1', 'qa-imp-2', 'qa-imp-3', 'qa-imp-4'] },
      { q: 'NOT impersonator.email:"omar@example.invalid" AND impersonator:sup_omar', rows: ['qa-imp-6'] },
      { q: 'impersonator.email:(omar@example.invalid OR nadia@example.invalid)', rows: ['qa-imp-3', 'qa-imp-4'] },
      { q: 'impersonator.email.work:"omar.work@example.invalid"', rows: ['qa-imp-6'] },
      { q: 'action:none OR impersonator.email:nadia*', rows: ['qa-imp-4'] },
    ];
    for (const { q, rows } of REFUSED_FILTERS) expect(await ids(unmasked.secret, q), `unmasked ${q}`).toEqual(rows);
    expect((await facets(unmasked.secret, { field: 'attr.impersonator.email' })).text).toMatch(ADDRESS);
    expect((await facets(unmasked.secret, { field: 'impersonator' })).text).toMatch(ADDRESS);
    expect(await exported(unmasked.secret, 'csv')).toMatch(ADDRESS);

    for (const [label, bearer] of [
      ['masked key', masked.secret],
      ['viewer token', token],
    ] as const) {
      // Search results: every event, each impersonator masked as expected, and no address anywhere in the page.
      const page = await search(bearer, '');
      expect(page.text, label).not.toMatch(ADDRESS);
      const data = page.body.data as Event[];
      expect(data.map((e) => e.id).sort(), label).toEqual(ALL);
      for (const e of data) expect(impersonatorOf(e), `${label} ${e.id}`).toEqual(EXPECTED[e.id]);
      for (const e of data) expect(e.impersonator?.name, `${label} ${e.id}`).toSatisfy((n: string) => n === 'Omar Support' || PSEUDONYM.test(n));

      // Event detail: the event and its impersonated parent, payload dropped.
      const detail = await get(bearer, '/events/qa-imp-2');
      expect(detail.status, label).toBe(200);
      expect(detail.text, label).not.toMatch(ADDRESS);
      expect(detail.body.payload, label).toBeNull();
      expect(impersonatorOf(detail.body.event), label).toEqual(EXPECTED['qa-imp-2']);
      expect(
        detail.body.parents.map((e: Event) => [e.id, impersonatorOf(e)]),
        label,
      ).toEqual([['qa-imp-1', EXPECTED['qa-imp-1']]]);
      for (const id of ALL) expect((await get(bearer, `/events/${id}`)).text, `${label} detail ${id}`).not.toMatch(ADDRESS);

      // Facets: impersonator labels at both levels and as a second level; the name pseudonyms match the events'.
      const byImpersonator = await facets(bearer, { field: 'impersonator' });
      expect(byImpersonator.text, label).not.toMatch(ADDRESS);
      expect(Object.fromEntries(byImpersonator.body.values.map((v) => [v.value, [v.label, v.count]])), label).toEqual({
        sup_rita: [p.rita, 2],
        sup_omar: ['Omar Support', 2],
        sup_nadia: [p.nadia, 1],
        sup_solo: [p.solo, 1],
      });
      for (const query of [
        { field: 'impersonator', by: 'impersonator' },
        { field: 'action', by: 'impersonator' },
        { field: 'impersonator', by: 'action' },
        { field: 'actor', by: 'impersonator' },
      ]) {
        const f = await facets(bearer, query);
        expect(f.text, `${label} ${JSON.stringify(query)}`).not.toMatch(ADDRESS);
      }
      const actionsBySupport = await facets(bearer, { field: 'action', by: 'impersonator' });
      const updated = actionsBySupport.body.values.find((v) => v.value === 'article.updated');
      expect(Object.fromEntries((updated?.groups ?? []).map((g) => [g.value, [g.label, g.count]])), label).toEqual({
        sup_rita: [p.rita, 1],
        sup_omar: ['Omar Support', 2],
        sup_nadia: [p.nadia, 1],
        sup_solo: [p.solo, 1],
      });

      // Refused: filters on the email attribute (search, facet filter, export filter) and facets on it at either level.
      const refused = [
        ...REFUSED_FILTERS.flatMap(({ q }) => [
          `/events?${new URLSearchParams({ q, from })}`,
          `/facets?${new URLSearchParams({ field: 'action', q, from })}`,
          `/export?${new URLSearchParams({ format: 'csv', q, from })}`,
        ]),
        `/facets?${new URLSearchParams({ field: 'attr.impersonator.email', from })}`,
        `/facets?${new URLSearchParams({ field: 'attributes.impersonator.email.work', from })}`,
        `/facets?${new URLSearchParams({ field: 'impersonator', by: 'attr.impersonator.email', from })}`,
      ];
      for (const path of refused) {
        const r = await get(bearer, path);
        expect(r.status, `${label} ${path}`).toBe(422);
        expect(r.body.error, `${label} ${path}`).toMatchObject({ code: 'invalid_query', details: { reason: 'not_allowed' } });
      }

      // Free text never matches the impersonator's address or name (they are not in the searchable text, masked or not).
      for (const q of ['rita@example.invalid', 'nadia', 'Solo@example.invalid', p.rita]) {
        expect(await ids(bearer, q), `${label} ${q}`).toEqual([]);
        expect(await ids(unmasked.secret, q), `unmasked ${q}`).toEqual([]);
      }
      // A pseudonym is not a filter value that reaches the address either.
      expect(await ids(bearer, `impersonator:${p.rita}`), label).toEqual([]);

      // Exports: CSV and JSONL carry the pseudonyms, never the address; the evidence export is refused.
      const csv = await exported(bearer, 'csv');
      expect(csv, label).not.toMatch(ADDRESS);
      expect(csv, label).toContain(p.rita);
      const jsonl = await exported(bearer, 'jsonl');
      expect(jsonl, label).not.toMatch(ADDRESS);
      const lines = jsonl
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Event);
      for (const e of lines) expect(impersonatorOf(e), `${label} jsonl ${e.id}`).toEqual(EXPECTED[e.id]);
      const evidence = await get(bearer, `/export?${new URLSearchParams({ format: 'jsonl-evidence', from })}`);
      expect(evidence.status, label).toBe(422);
      expect(evidence.body.error.code, label).toBe('masked_export');
    }

    // Webhook filters on the attribute: refused on create and on a PATCH that adds the mask; allowed without the mask.
    for (const { q } of REFUSED_FILTERS) {
      const r = await console_(ownerCookie, `/api/projects/${projectId}/webhooks`, 'POST', hookBody(q, ['actor_email']));
      expect(r.status, q).toBe(422);
      expect((await r.json()).error, q).toMatchObject({ code: 'invalid_query', details: { reason: 'not_allowed' } });
    }
    const filtered = await console_(ownerCookie, `/api/projects/${projectId}/webhooks`, 'POST', hookBody('impersonator.email:*'));
    expect(filtered.status, await filtered.clone().text()).toBe(201);
    const filteredId = (await filtered.json()).endpoint.id as string;
    const patched = await console_(ownerCookie, `/api/projects/${projectId}/webhooks/${filteredId}`, 'PATCH', {
      scope: { tenantId: 't1', mask: ['actor_email'] },
    });
    expect(patched.status, await patched.clone().text()).toBe(422);
    expect((await patched.json()).error).toMatchObject({ code: 'invalid_query', details: { reason: 'not_allowed' } });
    await prisma.webhookEndpoint.update({ where: { id: filteredId }, data: { enabled: false } });

    // Webhook bodies: discover past the ingest, then send to the local receiver. The masked endpoint's bodies carry the
    // pseudonyms only; the unmasked endpoint's carry the addresses (the positive control).
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
    expect(await discovered(hooks.plain)).toEqual(ALL);
    expect(await discovered(hooks.masked)).toEqual(ALL);
    const ids_ = Object.values(hooks);
    const pending = () => prisma.webhookDelivery.count({ where: { endpointId: { in: ids_ }, status: 'pending' } });
    for (let tick = 0; (await pending()) > 0; tick++) {
      if (tick === 40) throw new Error('Deliveries still pending after 40 sends');
      await deliverWebhooks(
        clickhouse,
        {
          secretKey: webhookSecretKey(env.BETTER_AUTH_SECRET, env.WEBHOOK_SECRET_KEY),
          maskKey: key,
          concurrency: 1,
          perEndpoint: 1,
          failureLimit: 50,
          transport: { allowHttp: true, allowAddress: (address) => address === '127.0.0.1' },
        },
        projectId,
      );
    }
    const bodies = (id: string) => received.filter((r) => r.path.startsWith(`/${id}`)).map((r) => r.payload);
    expect(bodies(hooks.masked)).toHaveLength(ALL.length);
    for (const body of bodies(hooks.masked)) {
      expect(body).not.toMatch(ADDRESS);
      const e = JSON.parse(body) as Event;
      expect(impersonatorOf(e), `webhook ${e.id}`).toEqual(EXPECTED[e.id]);
    }
    expect(bodies(hooks.plain)).toHaveLength(ALL.length);
    expect(bodies(hooks.plain).join('\n')).toMatch(ADDRESS);
    passed = true;
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    clearTokenKeyCache();
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
    // The organization and owner stay until the fixture's events are proven gone (see facet-mask-escape).
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
        }),
      );
    if (failures.length) {
      const error = new AggregateError(failures, `impersonator-mask cleanup failed: ${failures.map(String).join('; ')}`);
      if (passed) cleanupError = error;
      else console.error(JSON.stringify({ event: 'qa.impersonator_mask.cleanup_failed', failures: failures.map(String) }));
    }
  }
  if (cleanupError) throw cleanupError;
}, 600_000);
