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
 * #333, the HTTP layer over T1's facet and filter masking: under an actor_email mask, an actor name that carries an
 * address (the address as the name, the address inside the name, or an address sent only as the name) never comes out
 * through /v1/facets (values, groups, labels at both levels) or through filters on actor.name, for a masked scoped key
 * and a viewer token minted with that mask; and a masked webhook endpoint can neither discover nor send on such a name.
 * Every filter probe is first shown to select its rows without the mask, so an empty masked result is not vacuous.
 * Real services.
 */
const MAILPIT = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
const ADDRESS = /(lina|ada|solo)\s*@\s*example\.invalid/i;
const ADDRESS_ROWS = ['qa-mask-1', 'qa-mask-2', 'qa-mask-4', 'qa-mask-5'];

it('a masked reader cannot get an address-carrying actor name out of facets, filters or webhooks (real services)', async () => {
  const users: string[] = [];
  const mailIds: string[] = [];
  let organizationId = '';
  let project: { id: string; slug: string } | undefined;
  let ownerCookie = '';
  let passed = false;
  let cleanupError: Error | undefined;
  // Webhook sends go to this local receiver only (a worker sharing the database cannot send them: plain HTTP, loopback).
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
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'User-Agent': 'facet-mask-escape-test' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
      { incoming: { socket: { remoteAddress: '203.0.113.91' } } },
    );
  async function login() {
    const email = `qa-facet-mask-${randomUUID()}@example.invalid`;
    expect((await console_('', '/api/auth/email-otp/send-verification-otp', 'POST', { email, type: 'sign-in' })).status).toBe(200);
    // Poll for this recipient's message (the UUID address isolates it), with a deadline.
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
      name: 'QA facet mask',
      slug: `qa-facet-mask-${randomUUID()}`,
    });
    expect(org.status).toBe(200);
    organizationId = (await org.json()).id;
    const created = await console_(ownerCookie, '/api/projects', 'POST', { name: 'QA facet mask fixture' });
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

    // Webhook endpoints (#361 round 2): for each filter, an unmasked twin (the positive control) and a masked one. The
    // filters select address-carrying names case-sensitively, as the query language matches. Cursors start before the
    // ingest so discovery scans these events; URLs point at the local receiver.
    const WEBHOOK_PROBES = [
      { filter: 'actor.name:"Lina@example.invalid"', rows: ['qa-mask-1'] },
      { filter: 'actor.name:Ada*', rows: ['qa-mask-4'] },
      { filter: 'actor.name:Solo*', rows: ['qa-mask-5'] },
      { filter: 'actor.name:/.*@.*/', rows: ADDRESS_ROWS },
    ];
    const createHook = async (filterQuery: string, mask?: string[]) => {
      const r = await console_(ownerCookie, `/api/projects/${projectId}/webhooks`, 'POST', {
        url: 'https://8.8.8.8/qa-facet-mask',
        filterQuery,
        scope: { tenantId: 't1', ...(mask ? { mask } : {}) },
      });
      expect(r.status, await r.clone().text()).toBe(201);
      return (await r.json()).endpoint.id as string;
    };
    const hooks: { filter: string; rows: string[]; plain: string; masked: string }[] = [];
    for (const probe of WEBHOOK_PROBES)
      hooks.push({ ...probe, plain: await createHook(probe.filter), masked: await createHook(probe.filter, ['actor_email']) });
    const cursorFrom = new Date(+(await webhookCursorClock(prisma)).now - 60_000);
    for (const id of hooks.flatMap((h) => [h.plain, h.masked]))
      await prisma.webhookEndpoint.update({
        where: { id },
        data: { createdAt: cursorFrom, cursorReceivedAt: cursorFrom, url: `${receiverUrl}/${id}` },
      });

    // The address as the display name, in case and whitespace variants (one person: one group); the address inside the
    // name; an address sent only as the name, with no email; and an ordinary name.
    const ts = (n: number) => new Date(Date.now() - (60 - n) * 60_000).toISOString();
    const tenant = { id: 't1', name: 'Tenant one' };
    const events = [
      {
        id: 'qa-mask-1',
        occurredAt: ts(1),
        action: 'booking.created',
        tenant,
        actor: { type: 'user', id: 'u1', email: 'Lina@example.invalid', name: 'Lina@example.invalid' },
      },
      {
        id: 'qa-mask-2',
        occurredAt: ts(2),
        action: 'booking.updated',
        tenant,
        actor: { type: 'user', id: 'u1', email: 'lina@Example.invalid', name: ' LINA @ example.invalid ' },
      },
      {
        id: 'qa-mask-3',
        occurredAt: ts(3),
        action: 'booking.created',
        tenant,
        actor: { type: 'user', id: 'u2', email: 'omar@example.invalid', name: 'Omar Q' },
      },
      {
        id: 'qa-mask-4',
        occurredAt: ts(4),
        action: 'booking.created',
        tenant,
        actor: { type: 'user', id: 'u3', email: 'ada@example.invalid', name: 'Ada <ada@example.invalid>' },
      },
      { id: 'qa-mask-5', occurredAt: ts(5), action: 'booking.created', tenant, actor: { type: 'user', id: 'u4', name: 'Solo@example.invalid' } },
    ];
    const ingested = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${result.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    expect(ingested.status, await ingested.clone().text()).toBe(202);
    const ingestedAt = (await webhookCursorClock(prisma)).now;
    const from = '2026-01-01T00:00:00Z';
    const facets = async (bearer: string, query: Record<string, string>) => {
      const r = await v1(bearer, `/facets?${new URLSearchParams({ from, ...query })}`);
      expect(r.status, await r.clone().text()).toBe(200);
      const text = await r.text();
      return { text, body: facetResponseSchema.parse(JSON.parse(text)) };
    };
    // Every probe here is a supported query: anything but 200 fails, so a rejected query never passes as an empty result.
    const ids = async (bearer: string, q: string) => {
      const r = await v1(bearer, `/events?${new URLSearchParams({ q, from, limit: '100' })}`);
      expect(r.status, `${q}: ${await r.clone().text()}`).toBe(200);
      return ((await r.json()).data as { id: string }[]).map((e) => e.id).sort();
    };
    const actor = async (bearer: string, id: string) => {
      const r = await v1(bearer, `/events?${new URLSearchParams({ q: `id:${id}`, from })}`);
      expect(r.status).toBe(200);
      return (await r.json()).data[0].actor as { name: string; email: string };
    };

    // Contrast: without the mask the addresses are visible, and every probe selects its rows.
    expect((await facets(unmasked.secret, { field: 'actor.name' })).text).toMatch(ADDRESS);
    const stored = Object.fromEntries(await Promise.all(ADDRESS_ROWS.map(async (id) => [id, (await actor(unmasked.secret, id)).name] as const)));
    const PROBES: { q: string; rows: string[] }[] = [
      // Each name exactly as stored (the spaced Lina variant included).
      ...ADDRESS_ROWS.map((id) => ({ q: `actor.name:"${stored[id]}"`, rows: [id] })),
      { q: 'actor.name:Lina*', rows: ['qa-mask-1'] },
      { q: 'actor.name:Ada*', rows: ['qa-mask-4'] },
      { q: 'actor.name:Solo*', rows: ['qa-mask-5'] },
      { q: 'actor.name:/.*@.*/', rows: ADDRESS_ROWS },
      { q: 'actor.name:/.*[Ll][Ii][Nn][Aa].*/', rows: ['qa-mask-1', 'qa-mask-2'] },
    ];
    for (const { q, rows } of PROBES) expect(await ids(unmasked.secret, q), `unmasked ${q}`).toEqual(rows);
    // Free text finds the address rows without the mask (it may also match the email, so only containment is required).
    const FREE_TEXT = ['Lina@example.invalid', 'ada@example.invalid', 'Solo@example.invalid'];
    for (const q of FREE_TEXT) {
      const found = await ids(unmasked.secret, q);
      expect(found.length, `unmasked ${q}`).toBeGreaterThan(0);
      expect(ADDRESS_ROWS, `unmasked ${q}`).toEqual(expect.arrayContaining(found));
    }

    const key = fieldMaskKey(env.BETTER_AUTH_SECRET);
    // The email's own pseudonym when the name contains the email; an address only as the name hashes its normalised self.
    const pseudonym = {
      lina: maskedEmail(projectId, 'lina@example.invalid', key),
      ada: maskedEmail(projectId, 'ada@example.invalid', key),
      solo: maskedEmail(projectId, 'solo@example.invalid', key),
    };
    const name = { u1: pseudonym.lina, u2: 'Omar Q', u3: pseudonym.ada, u4: pseudonym.solo };
    const byValue = (values: { value: string; count: number; groups?: { value: string; count: number }[] }[]) =>
      Object.fromEntries(
        values.map((v) => [v.value, v.groups ? { count: v.count, groups: Object.fromEntries(v.groups.map((g) => [g.value, g.count])) } : v.count]),
      );

    for (const bearer of [masked.secret, token]) {
      // Values: each address-carrying name is one pseudonym group (Lina's two variants together), the ordinary name stays.
      const byName = await facets(bearer, { field: 'actor.name' });
      expect(byName.text).not.toMatch(ADDRESS);
      expect(byName.text).not.toMatch(/Ada\b/);
      expect(byValue(byName.body.values)).toEqual({ [pseudonym.lina]: 2, [pseudonym.ada]: 1, [pseudonym.solo]: 1, 'Omar Q': 1 });
      // The facet pseudonyms are byte-identical to the ones the events carry, for every address row.
      expect(await actor(bearer, 'qa-mask-1')).toMatchObject({ name: pseudonym.lina, email: pseudonym.lina });
      expect(await actor(bearer, 'qa-mask-2')).toMatchObject({ name: pseudonym.lina, email: pseudonym.lina });
      expect(await actor(bearer, 'qa-mask-4')).toMatchObject({ name: pseudonym.ada, email: pseudonym.ada });
      expect((await actor(bearer, 'qa-mask-5')).name).toBe(pseudonym.solo);
      // Labels and groups at both levels, with the expected values present.
      const actors = await facets(bearer, { field: 'actor' });
      expect(actors.text).not.toMatch(ADDRESS);
      expect(Object.fromEntries(actors.body.values.map((v) => [v.value, [v.label, v.count]]))).toEqual({
        u1: [name.u1, 2],
        u2: [name.u2, 1],
        u3: [name.u3, 1],
        u4: [name.u4, 1],
      });
      const actorsByName = await facets(bearer, { field: 'actor', by: 'actor.name' });
      expect(actorsByName.text).not.toMatch(ADDRESS);
      expect(byValue(actorsByName.body.values)).toEqual({
        u1: { count: 2, groups: { [name.u1]: 2 } },
        u2: { count: 1, groups: { [name.u2]: 1 } },
        u3: { count: 1, groups: { [name.u3]: 1 } },
        u4: { count: 1, groups: { [name.u4]: 1 } },
      });
      const actionsByName = await facets(bearer, { field: 'action', by: 'actor.name' });
      expect(actionsByName.text).not.toMatch(ADDRESS);
      expect(byValue(actionsByName.body.values)).toEqual({
        'booking.created': { count: 4, groups: { [name.u1]: 1, [name.u2]: 1, [name.u3]: 1, [name.u4]: 1 } },
        'booking.updated': { count: 1, groups: { [name.u1]: 1 } },
      });
      const namesByActor = await facets(bearer, { field: 'actor.name', by: 'actor' });
      expect(namesByActor.text).not.toMatch(ADDRESS);
      expect(byValue(namesByActor.body.values)).toEqual({
        [name.u1]: { count: 2, groups: { u1: 2 } },
        [name.u2]: { count: 1, groups: { u2: 1 } },
        [name.u3]: { count: 1, groups: { u3: 1 } },
        [name.u4]: { count: 1, groups: { u4: 1 } },
      });
      // The same probes find none of the address rows under the mask; nor do the pseudonyms or free text.
      for (const { q } of PROBES) expect(await ids(bearer, q), q).toEqual([]);
      for (const value of Object.values(pseudonym)) expect(await ids(bearer, `actor.name:"${value}"`), value).toEqual([]);
      for (const q of FREE_TEXT) expect(await ids(bearer, q), q).toEqual([]);
      // Ordinary names still filter.
      expect(await ids(bearer, 'actor.name:"Omar Q"')).toEqual(['qa-mask-3']);
    }

    // Webhook discovery. Discovery reads only up to its watermark (now minus the async-insert flush bound and a margin), so
    // each endpoint scans until its cursor has passed the ingest: an empty result then covers the events.
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
    for (const hook of hooks) {
      expect(await discovered(hook.plain), `unmasked ${hook.filter}`).toEqual(hook.rows);
      expect(await discovered(hook.masked), `masked ${hook.filter}`).toEqual([]);
    }

    // Send time: deliveries queued while an endpoint was unmasked, then the endpoint gains the mask. The sender rechecks each
    // delivery against the endpoint's current filter and scope: nothing is sent and each is skipped as scope_mismatch.
    // The other unmasked endpoints' deliveries are sent (the positive control for the sender).
    const regex = hooks.at(-1);
    if (!regex) throw new Error('missing regex probe');
    const patched = await console_(ownerCookie, `/api/projects/${projectId}/webhooks/${regex.plain}`, 'PATCH', {
      scope: { tenantId: 't1', mask: ['actor_email'] },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    const plainIds = hooks.map((h) => h.plain);
    const pending = () => prisma.webhookDelivery.count({ where: { endpointId: { in: plainIds }, status: 'pending' } });
    for (let tick = 0; (await pending()) > 0; tick++) {
      if (tick === 30) throw new Error('Deliveries still pending after 30 sends');
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
    expect(received.filter((r) => r.path.startsWith(`/${regex.plain}`))).toEqual([]);
    const skipped = await prisma.webhookDelivery.findMany({ where: { endpointId: regex.plain }, include: { attempts: true } });
    expect(skipped.map((d) => [d.eventId, d.status, d.attempts.map((a) => a.error)]).sort()).toEqual(
      ADDRESS_ROWS.map((id) => [id, 'skipped', ['scope_mismatch']]),
    );
    for (const hook of hooks.slice(0, -1)) {
      const sent = received.filter((r) => r.path.startsWith(`/${hook.plain}`)).map((r) => JSON.parse(r.payload).id);
      expect(sent.sort(), `sent ${hook.filter}`).toEqual(hook.rows);
    }
    expect(received.some((r) => hooks.some((h) => r.path.startsWith(`/${h.masked}`)))).toBe(false);
    passed = true;
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    clearTokenKeyCache();
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
      // Whatever the delete did, the project's events must be gone before its owner is removed: purge them directly
      // otherwise, and fail if any remain (an organisation cascade would orphan them where retention never looks).
      await step(async () => {
        const remaining = async () =>
          Number((await read<{ n: string }>(clickhouse, 'SELECT count() n FROM events WHERE project_id = {p:String}', { p: id }))[0]?.n);
        if ((await remaining()) > 0) await purgeProject(clickhouse, id);
        if ((await remaining()) > 0) throw new Error(`events of fixture project ${id} remain`);
      });
    }
    if (organizationId) {
      await step(() => prisma.auditOutbox.deleteMany({ where: { stream: `ws:${organizationId}` } }));
      await step(() => purgeProject(clickhouse, `ws:${organizationId}`));
      await step(() => prisma.organization.delete({ where: { id: organizationId } }));
    }
    await step(() => prisma.user.deleteMany({ where: { id: { in: users } } }));
    if (mailIds.length)
      await step(() =>
        fetch(`${MAILPIT}/api/v1/messages`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ IDs: mailIds }),
        }),
      );
    if (failures.length) {
      const error = new AggregateError(failures, `facet-mask-escape cleanup failed: ${failures.map(String).join('; ')}`);
      // A green run must not leave fixtures behind; after a failure, keep the original error and report this one.
      if (passed) cleanupError = error;
      else console.error(JSON.stringify({ event: 'qa.facet_mask_escape.cleanup_failed', failures: failures.map(String) }));
    }
  }
  if (cleanupError) throw cleanupError;
}, 600_000);
