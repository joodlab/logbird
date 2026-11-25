import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fieldMaskKey, maskedEmail, purgeProject, read } from '@logbird/clickhouse';
import { createApiKeyResponseSchema, createProjectResponseSchema, facetResponseSchema, storedWebhookScope } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { webhookCursorClock, webhookSecretKey } from '@logbird/database/webhooks';
import { expect, it } from 'vitest';
import { deliverWebhooks } from '../../worker/src/webhook-delivery';
import { discoverWebhookDeliveries, webhookEvent } from '../../worker/src/webhook-discovery';
import { app } from './app';
import { clickhouse } from './clickhouse';
import { env } from './env';
import { clearTokenKeyCache } from './read-access';

/**
 * Under an actor_email mask, the impersonator (a support person acting as the actor) is masked like the actor: the email
 * ingest keeps as the attribute `impersonator.email` shows as a role-keyed pseudonym (never the one the same address
 * has as an actor), attribute paths below it are removed (their keys can be addresses), and an impersonator name that
 * carries an address shows as a pseudonym (the email's whenever there is one). For a masked scoped key and
 * a viewer token minted with that mask, the address never comes out of search results, event detail (event and
 * parents), facets (values, labels, groups), export (CSV, JSONL), or webhook bodies; filters and facets on the
 * attribute are refused (422 not_allowed), also in webhook filters. Unmasked readers see the stored values. Real
 * services.
 */
const MAILPIT = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
/** Every fixture address (and the address-carrying names) contains one of these local parts. */
const ADDRESS = /(rita|omar|solo|nadia)[\w.]*\s*@\s*example\.invalid/i;
const PSEUDONYM = /^masked:[0-9a-f]{24}$/;

/** A display label cut at the 512-unit name cap right after an address's local part (the '@' is lost). */
const LONG_LOCAL = 'rita.long';
const LONG_PREFIX = 'Support desk ';
/** 510 and 511 UTF-16 units, one astral character (two units) each: below and at the capped-name rule's threshold. */
const NAME_510 = `Support \u{1F600}${'a'.repeat(500)}`;
const NAME_511 = `Support \u{1F600}${'a'.repeat(501)}`;
/** 511 zero-width spaces: at the cap rule's threshold, and empty once whitespace is removed. */
const ZW_511 = '​'.repeat(511);
const LONG_LABEL = `${LONG_PREFIX}${'-'.repeat(512 - LONG_PREFIX.length - LONG_LOCAL.length)}${LONG_LOCAL}@example.invalid`;

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
    // `stale` is masked and gets a filter on the email attribute written straight to the database once its deliveries
    // are queued: a filter stored before the mask covered that attribute.
    const hooks = { plain: await createHook(), masked: await createHook(['actor_email']), stale: await createHook(['actor_email']) };
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
        // An email sent as an object: its member names become attribute keys, and a key can be an address itself.
        impersonator: { id: 'sup_omar', name: 'Omar Support', email: { work: 'omar.work@example.invalid', 'omar.desk@example.invalid': 'primary' } },
      },
      // A long display label that ends with an address, cut at the 512-unit name cap inside it: the stored name ends
      // with the address's local part and no '@'.
      { id: 'qa-imp-7', occurredAt: ts(7), action: 'article.updated', tenant, actor, impersonator: { id: 'sup_long', name: LONG_LABEL } },
      // The same person as an actor: their actor pseudonym must differ from their impersonator pseudonym (role-keyed).
      {
        id: 'qa-imp-8',
        occurredAt: ts(8),
        action: 'article.viewed',
        tenant,
        actor: { type: 'user', id: 'u_rita', name: 'Rita Actor', email: 'rita@example.invalid' },
      },
      // Names just below and at the 511-unit cap rule, with an astral character (two UTF-16 units, one code point), so
      // SQL (facet labels) and TypeScript (events) must count UTF-16 units alike.
      { id: 'qa-imp-9', occurredAt: ts(9), action: 'article.updated', tenant, actor, impersonator: { id: 'sup_510', name: NAME_510 } },
      { id: 'qa-imp-10', occurredAt: ts(10), action: 'article.updated', tenant, actor, impersonator: { id: 'sup_511', name: NAME_511 } },
      // A name holding an old address while the email is a new one: the name still shows the email's pseudonym, so a
      // reader cannot tell from equal or different pseudonyms whether the name holds the stored address.
      {
        id: 'qa-imp-11',
        occurredAt: ts(11),
        action: 'article.updated',
        tenant,
        actor,
        impersonator: { id: 'sup_move', name: 'Moved <omar.old@example.invalid>', email: 'omar.new@example.invalid' },
      },
      // A capped name that normalises to nothing (zero-width spaces), with no email: still a pseudonym.
      { id: 'qa-imp-12', occurredAt: ts(12), action: 'article.updated', tenant, actor, impersonator: { id: 'sup_zw', name: ZW_511 } },
    ];
    const ingested = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${result.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    expect(ingested.status, await ingested.clone().text()).toBe(202);
    const ingestedAt = (await webhookCursorClock(prisma)).now;
    const from = '2026-01-01T00:00:00Z';
    const ALL = events.map((e) => e.id).sort();
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
    const storedLong = LONG_LABEL.slice(0, 512);
    expect(storedLong.endsWith(LONG_LOCAL)).toBe(true);
    expect([NAME_510.length, NAME_511.length]).toEqual([510, 511]);
    // Impersonator pseudonyms are keyed by role; the actor's pseudonym of the same address differs.
    const imp = (text: string) => maskedEmail(projectId, text, key, 'impersonator');
    const p = {
      long: imp(storedLong.replace(/\s/g, '').toLowerCase()),
      rita: imp('rita@example.invalid'),
      omar: imp('omar@example.invalid'),
      nadia: imp('nadia@example.invalid'),
      solo: imp('solo@example.invalid'),
      moved: imp('omar.new@example.invalid'),
      zw: imp(ZW_511),
      n511: imp(NAME_511.replace(/\s/g, '').toLowerCase()),
      ritaActor: maskedEmail(projectId, 'rita@example.invalid', key),
    };
    expect(p.rita).not.toBe(p.ritaActor);
    // The masked label of each impersonator id, in facets ('' for events without an impersonator).
    const LABEL: Record<string, string> = {
      sup_rita: p.rita,
      sup_omar: 'Omar Support',
      sup_nadia: p.nadia,
      sup_solo: p.solo,
      sup_long: p.long,
      sup_510: NAME_510,
      sup_511: p.n511,
      sup_move: p.moved,
      sup_zw: p.zw,
      '': '',
    };
    // Expected two-level facets, computed from the fixture: value -> { count, groups: { group -> count } }.
    const DIMENSION: Record<string, (e: (typeof events)[number]) => string> = {
      impersonator: (e) => e.impersonator?.id ?? '',
      action: (e) => e.action,
      actor: (e) => e.actor.id,
    };
    const expectedFacet = (field: string, by: string) => {
      const out: Record<string, { count: number; groups: Record<string, number> }> = {};
      for (const e of events) {
        const value = DIMENSION[field]?.(e) ?? '';
        const group = DIMENSION[by]?.(e) ?? '';
        out[value] ??= { count: 0, groups: {} };
        out[value].count++;
        out[value].groups[group] = (out[value].groups[group] ?? 0) + 1;
      }
      return out;
    };
    const facetMap = (values: { value: string; count: number; groups?: { value: string; count: number }[] }[]) =>
      Object.fromEntries(
        values.map((v) => [v.value, { count: v.count, groups: Object.fromEntries((v.groups ?? []).map((g) => [g.value, g.count])) }]),
      );
    /** Minimal CSV reader for the export (quoted cells with doubled quotes; no line breaks inside cells here). */
    const csvRows = (text: string) =>
      text
        .trim()
        .split('\n')
        .map((line) => {
          const cells: string[] = [];
          let cell = '';
          let quoted = false;
          for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (quoted && c === '"' && line[i + 1] === '"') {
              cell += '"';
              i++;
            } else if (c === '"') quoted = !quoted;
            else if (c === ',' && !quoted) {
              cells.push(cell);
              cell = '';
            } else cell += c;
          }
          cells.push(cell);
          return cells;
        });
    // What each event's impersonator looks like under the mask: name and the email attribute(s).
    const EXPECTED: Record<string, { name: string; attributes: Record<string, string> }> = {
      'qa-imp-1': { name: p.rita, attributes: { 'impersonator.email': p.rita } },
      'qa-imp-2': { name: p.rita, attributes: { 'impersonator.email': p.rita } },
      'qa-imp-3': { name: 'Omar Support', attributes: { 'impersonator.email': p.omar } },
      'qa-imp-4': { name: p.nadia, attributes: { 'impersonator.email': p.nadia } },
      'qa-imp-5': { name: p.solo, attributes: {} },
      // Paths below the email are dropped whole under the mask (their keys are producer text).
      'qa-imp-6': { name: 'Omar Support', attributes: {} },
      'qa-imp-7': { name: p.long, attributes: {} },
      'qa-imp-8': { name: undefined as unknown as string, attributes: {} },
      'qa-imp-9': { name: NAME_510, attributes: {} },
      'qa-imp-10': { name: p.n511, attributes: {} },
      'qa-imp-11': { name: p.moved, attributes: { 'impersonator.email': p.moved } },
      'qa-imp-12': { name: p.zw, attributes: {} },
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
    expect(Object.keys((plainPage.body.data as Event[]).find((e) => e.id === 'qa-imp-6')?.attributes ?? {})).toContain(
      'impersonator.email.omar.desk@example.invalid',
    );
    expect((plainPage.body.data as Event[]).find((e) => e.id === 'qa-imp-7')?.impersonator?.name).toBe(storedLong);
    const REFUSED_FILTERS: { q: string; rows: string[] }[] = [
      { q: 'impersonator.email:"Rita@example.invalid"', rows: ['qa-imp-1'] },
      { q: 'attr.impersonator.email:rita*', rows: ['qa-imp-2'] },
      { q: 'attributes.impersonator.email:/.*@.*/', rows: ['qa-imp-1', 'qa-imp-11', 'qa-imp-2', 'qa-imp-3', 'qa-imp-4'] },
      { q: '_exists_:impersonator.email', rows: ['qa-imp-1', 'qa-imp-11', 'qa-imp-2', 'qa-imp-3', 'qa-imp-4'] },
      { q: 'impersonator.email:*', rows: ['qa-imp-1', 'qa-imp-11', 'qa-imp-2', 'qa-imp-3', 'qa-imp-4'] },
      { q: 'NOT impersonator.email:"omar@example.invalid" AND impersonator:sup_omar', rows: ['qa-imp-6'] },
      { q: 'impersonator.email:(omar@example.invalid OR nadia@example.invalid)', rows: ['qa-imp-3', 'qa-imp-4'] },
      { q: 'impersonator.email.work:"omar.work@example.invalid"', rows: ['qa-imp-6'] },
      { q: 'action:none OR impersonator.email:nadia*', rows: ['qa-imp-4'] },
      { q: '_exists_:"impersonator.email.omar.desk@example.invalid"', rows: ['qa-imp-6'] },
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
      expect(page.text, label).not.toContain(LONG_LOCAL);
      const data = page.body.data as Event[];
      expect(data.map((e) => e.id).sort(), label).toEqual(ALL);
      for (const e of data) expect(impersonatorOf(e), `${label} ${e.id}`).toEqual(EXPECTED[e.id]);
      // The same address as an actor gets the actor's pseudonym, which differs from the impersonator's.
      expect((data.find((e) => e.id === 'qa-imp-8') as Event & { actor: { email: string } }).actor.email, label).toBe(p.ritaActor);
      expect(PSEUDONYM.test(p.rita) && PSEUDONYM.test(p.ritaActor), label).toBe(true);
      for (const e of data) expect(Object.keys(e.attributes).join(' '), `${label} ${e.id} keys`).not.toMatch(ADDRESS);

      // Paging: three at a time, newest first, the same order and total as the unmasked reader's.
      const paged: string[] = [];
      let cursor: string | null = null;
      for (let n = 0; n === 0 || cursor; n++) {
        if (n === 10) throw new Error('paging did not end');
        const r = await get(bearer, `/events?${new URLSearchParams({ from, limit: '3', ...(cursor ? { cursor } : {}) })}`);
        expect(r.status, label).toBe(200);
        expect([r.body.total, r.body.totalExact], label).toEqual([ALL.length, true]);
        expect(r.text, label).not.toMatch(ADDRESS);
        paged.push(...(r.body.data as Event[]).map((e) => e.id));
        cursor = r.body.nextCursor;
      }
      expect(paged, label).toEqual((plainPage.body.data as Event[]).map((e) => e.id));

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
      expect([detail.body.childCount, detail.body.operationSize], label).toEqual([0, 2]);
      const parent = await get(bearer, '/events/qa-imp-1');
      expect([parent.status, parent.body.childCount, parent.body.operationSize], label).toEqual([200, 1, 2]);
      for (const id of ALL) {
        const one = await get(bearer, `/events/${id}`);
        expect(one.status, `${label} detail ${id}`).toBe(200);
        expect(one.text, `${label} detail ${id}`).not.toMatch(ADDRESS);
        expect(one.text, `${label} detail ${id}`).not.toContain(LONG_LOCAL);
        expect(impersonatorOf(one.body.event), `${label} detail ${id}`).toEqual(EXPECTED[id]);
      }

      // Facets: impersonator labels at both levels and as a second level; the name pseudonyms match the events'.
      const byImpersonator = await facets(bearer, { field: 'impersonator' });
      expect(byImpersonator.text, label).not.toMatch(ADDRESS);
      expect(byImpersonator.text, label).not.toContain(LONG_LOCAL);
      expect(Object.fromEntries(byImpersonator.body.values.map((v) => [v.value, [v.label, v.count]])), label).toEqual(
        Object.fromEntries(Object.entries(expectedFacet('impersonator', 'impersonator')).map(([v, { count }]) => [v, [LABEL[v], count]])),
      );
      expect(byImpersonator.body.otherCount, label).toBe(0);
      for (const query of [
        { field: 'impersonator', by: 'impersonator' },
        { field: 'action', by: 'impersonator' },
        { field: 'impersonator', by: 'action' },
        { field: 'actor', by: 'impersonator' },
      ]) {
        const f = await facets(bearer, { ...query, byLimit: '10' });
        expect(f.text, `${label} ${JSON.stringify(query)}`).not.toMatch(ADDRESS);
        expect(f.text, `${label} ${JSON.stringify(query)}`).not.toContain(LONG_LOCAL);
        // Exactly the fixture's values and groups, nothing dropped or merged.
        expect(facetMap(f.body.values), `${label} ${JSON.stringify(query)}`).toEqual(expectedFacet(query.field, query.by));
        expect(f.body.otherCount, `${label} ${JSON.stringify(query)}`).toBe(0);
        for (const v of f.body.values) expect(v.groupsOtherCount ?? 0, `${label} ${JSON.stringify(query)}`).toBe(0);
      }
      const actionsBySupport = await facets(bearer, { field: 'action', by: 'impersonator', byLimit: '10' });
      // Limits with ties: the top two impersonators (two events each) and the rest counted; a third pick among the
      // one-event ties keeps its masked label; one group per action at the second level, the rest counted.
      const top2 = await facets(bearer, { field: 'impersonator', limit: '2' });
      expect(Object.fromEntries(top2.body.values.map((v) => [v.value, [v.label, v.count]])), label).toEqual({
        sup_rita: [p.rita, 2],
        sup_omar: ['Omar Support', 2],
      });
      expect(top2.body.otherCount, label).toBe(ALL.length - 4);
      const top3 = await facets(bearer, { field: 'impersonator', limit: '3' });
      expect(
        top3.body.values.map((v) => v.count),
        label,
      ).toEqual([2, 2, 1]);
      for (const v of top3.body.values) expect(v.label, label).toBe(LABEL[v.value] || v.value);
      expect(top3.body.otherCount, label).toBe(ALL.length - 5);
      const byOne = await facets(bearer, { field: 'action', by: 'impersonator', byLimit: '1' });
      expect(byOne.text, label).not.toMatch(ADDRESS);
      const expectedByOne = expectedFacet('action', 'impersonator');
      for (const v of byOne.body.values) {
        expect(v.groups?.length, `${label} ${v.value}`).toBe(1);
        const [group] = v.groups ?? [];
        const best = Math.max(...Object.values(expectedByOne[v.value]?.groups ?? {}));
        expect(group?.count, `${label} ${v.value}`).toBe(best);
        expect(group?.label, `${label} ${v.value}`).toBe(LABEL[group?.value ?? ''] || group?.value);
        expect(v.groupsOtherCount, `${label} ${v.value}`).toBe(v.count - best);
      }
      expect(byOne.body.values.find((v) => v.value === 'article.updated')?.groups?.[0]?.value, label).toBe('sup_omar');

      // Group labels follow the same rule as first-level labels.
      for (const v of actionsBySupport.body.values)
        for (const g of v.groups ?? []) expect(g.label, `${label} ${v.value} ${g.value}`).toBe(LABEL[g.value] || g.value);

      // Refused: filters on the email attribute (search, facet filter, export filter) and facets on it at either level.
      const refused = [
        ...REFUSED_FILTERS.flatMap(({ q }) => [
          `/events?${new URLSearchParams({ q, from })}`,
          `/facets?${new URLSearchParams({ field: 'action', q, from })}`,
          `/export?${new URLSearchParams({ format: 'csv', q, from })}`,
        ]),
        // A range (attribute ranges are numeric or dates, so it cannot select an address even unmasked; still refused).
        `/events?${new URLSearchParams({ q: 'impersonator.email:[0 TO 9]', from })}`,
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
      expect(csv, label).not.toContain(LONG_LOCAL);
      const [header = [], ...rows] = csvRows(csv);
      const column = (name: string) => header.indexOf(name);
      expect(rows.map((r) => r[column('id')]).sort(), label).toEqual(ALL);
      for (const r of rows) {
        const id = r[column('id')] ?? '';
        const attributes = JSON.parse(r[column('attributes')] || '{}') as Record<string, string>;
        expect(
          { name: r[column('impersonator_name')] || undefined, attributes: impersonatorOf({ id, impersonator: null, attributes }).attributes },
          `${label} csv ${id}`,
        ).toEqual({ ...EXPECTED[id], name: EXPECTED[id]?.name || undefined });
      }
      const jsonl = await exported(bearer, 'jsonl');
      expect(jsonl, label).not.toMatch(ADDRESS);
      expect(jsonl, label).not.toContain(LONG_LOCAL);
      const lines = jsonl
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Event);
      expect(lines.map((e) => e.id).sort(), label).toEqual(ALL);
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
    expect(await discovered(hooks.stale)).toEqual(ALL);
    await prisma.webhookEndpoint.update({ where: { id: hooks.stale }, data: { filterQuery: 'impersonator.email:*' } });
    const ids_ = [hooks.plain, hooks.masked];
    const pending = () => prisma.webhookDelivery.count({ where: { endpointId: { in: ids_ }, status: 'pending' } });
    // Also until the stale endpoint's deliveries have been tried at least once.
    const staleTried = () => prisma.webhookAttempt.count({ where: { delivery: { endpointId: hooks.stale }, error: { not: null } } });
    for (let tick = 0; (await pending()) > 0 || (await staleTried()) === 0; tick++) {
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
    expect(
      bodies(hooks.masked)
        .map((b) => (JSON.parse(b) as Event).id)
        .sort(),
    ).toEqual(ALL);
    for (const body of bodies(hooks.masked)) {
      expect(body).not.toMatch(ADDRESS);
      const e = JSON.parse(body) as Event;
      expect(impersonatorOf(e), `webhook ${e.id}`).toEqual(EXPECTED[e.id]);
    }
    expect(
      bodies(hooks.plain)
        .map((b) => (JSON.parse(b) as Event).id)
        .sort(),
    ).toEqual(ALL);
    expect(bodies(hooks.plain).join('\n')).toMatch(ADDRESS);
    // The stale filter: the sender's recheck cannot compile it under the mask, so nothing is sent (a retryable lookup
    // failure), and the next discovery scan holds the endpoint for a filter edit.
    expect(bodies(hooks.stale)).toEqual([]);
    const stale = await prisma.webhookDelivery.findMany({ where: { endpointId: hooks.stale }, include: { attempts: true } });
    expect(stale).toHaveLength(ALL.length);
    expect(stale.some((d) => d.status === 'sent')).toBe(false);
    const staleErrors = stale.flatMap((d) => d.attempts.map((a) => a.error));
    expect(staleErrors.length).toBeGreaterThan(0);
    expect(new Set(staleErrors)).toEqual(new Set(['lookup_failed']));
    await discoverWebhookDeliveries(clickhouse, await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hooks.stale } }), {
      now: (await webhookCursorClock(prisma)).now,
      rollout: new Date(+cursorFrom - 1),
    });
    expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hooks.stale } })).toMatchObject({
      filterReviewRequired: true,
      filterReviewReason: 'invalid_filter',
    });
    // The cause at send time: the sender's own lookup refuses the stored filter under the mask (not a timeout), and
    // finds the same queued event once the filter is allowed.
    const staleEndpoint = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hooks.stale } });
    const staleScope = storedWebhookScope(staleEndpoint) ?? null;
    const [queued] = stale;
    if (!queued?.receivedAt) throw new Error('missing queued stale delivery');
    await expect(webhookEvent(clickhouse, staleEndpoint, staleScope, queued.eventId, queued.receivedAt)).rejects.toMatchObject({
      details: { reason: 'not_allowed' },
    });
    expect(await webhookEvent(clickhouse, { ...staleEndpoint, filterQuery: '' }, staleScope, queued.eventId, queued.receivedAt)).toMatchObject({
      id: queued.eventId,
    });
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
