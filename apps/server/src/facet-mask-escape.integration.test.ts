import { randomUUID } from 'node:crypto';
import { fieldMaskKey, maskedEmail, purgeProject } from '@logbird/clickhouse';
import { createApiKeyResponseSchema, createProjectResponseSchema, facetResponseSchema } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { webhookCursorClock } from '@logbird/database/webhooks';
import { expect, it } from 'vitest';
import { discoverWebhookDeliveries } from '../../worker/src/webhook-discovery';
import { app } from './app';
import { clickhouse } from './clickhouse';
import { env } from './env';
import { clearTokenKeyCache } from './read-access';

/**
 * #333, the HTTP layer over T1's facet and filter masking: under an actor_email mask, an actor name that carries an
 * address (the address as the name, the address inside the name, or an address sent only as the name) never comes out
 * through /v1/facets (values, groups, labels at both levels) or through filters on actor.name, for a masked scoped key,
 * for a viewer token minted with that mask, and for a masked webhook endpoint's filter. Real services.
 */
const MAILPIT = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
const ADDRESS = /(lina|ada|solo)\s*@\s*example\.invalid/i;

it('a masked reader cannot get an address used as the actor name out of facets or filters (real services)', async () => {
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
    const mailbox = await (await fetch(`${MAILPIT}/api/v1/messages?limit=100`)).json();
    const message = mailbox.messages.find((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === email));
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
      name: 'QA facet mask',
      slug: `qa-facet-mask-${randomUUID()}`,
    });
    expect(org.status).toBe(200);
    organizationId = (await org.json()).id;
    const created = await console_(ownerCookie, '/api/projects', 'POST', { name: 'QA facet mask fixture' });
    expect(created.status).toBe(201);
    const result = createProjectResponseSchema.parse(await created.json());
    project = result.project;
    const createKey = async (body: Record<string, unknown>) => {
      const r = await console_(ownerCookie, `/api/projects/${project?.id}/keys`, 'POST', body);
      expect(r.status, await r.clone().text()).toBe(201);
      return createApiKeyResponseSchema.parse(await r.json());
    };
    const masked = await createKey({ name: 'Masked t1', kind: 'scoped-read', scope: { tenantId: 't1', mask: ['actor_email'] } });
    const unmasked = await createKey({ name: 'Plain t1', kind: 'scoped-read', scope: { tenantId: 't1' } });
    const read = await createKey({ name: 'Server', kind: 'read' });
    const minted = await v1(read.secret, '/viewer-tokens', { method: 'POST', body: { scope: { tenantId: 't1', mask: ['actor_email'] } } });
    expect(minted.status, await minted.clone().text()).toBe(201);
    const token = (await minted.json()).token as string;

    // Masked webhook endpoints (#361 round 2) whose filters select on an address-carrying name, and an unmasked contrast.
    // Their cursors start before the ingest so discovery scans these events.
    // The first is the name exactly as stored, so the unmasked contrast matches it.
    const NAME_FILTERS = [
      'actor.name:"Lina@example.invalid"',
      'actor.name:"lina@example.invalid"',
      'actor.name:ada*',
      'actor.name:*@example.invalid',
    ];
    const createHook = async (filterQuery: string, mask?: string[]) => {
      const r = await console_(ownerCookie, `/api/projects/${project?.id}/webhooks`, 'POST', {
        url: 'https://8.8.8.8/qa-facet-mask',
        filterQuery,
        scope: { tenantId: 't1', ...(mask ? { mask } : {}) },
      });
      expect(r.status, await r.clone().text()).toBe(201);
      return (await r.json()).endpoint.id as string;
    };
    const maskedHooks: string[] = [];
    for (const filter of NAME_FILTERS) maskedHooks.push(await createHook(filter, ['actor_email']));
    const plainHook = await createHook(NAME_FILTERS[0] as string);
    const cursorFrom = new Date(+(await webhookCursorClock(prisma)).now - 60_000);
    await prisma.webhookEndpoint.updateMany({
      where: { id: { in: [...maskedHooks, plainHook] } },
      data: { createdAt: cursorFrom, cursorReceivedAt: cursorFrom },
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
      {
        id: 'qa-mask-5',
        occurredAt: ts(5),
        action: 'booking.created',
        tenant,
        actor: { type: 'user', id: 'u4', name: 'Solo@example.invalid' },
      },
    ];
    const ingested = await app.request('/v1/events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${result.ingestKey.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    expect(ingested.status, await ingested.clone().text()).toBe(202);
    const from = '2026-01-01T00:00:00Z';
    const facets = async (bearer: string, query: Record<string, string>) => {
      const r = await v1(bearer, `/facets?${new URLSearchParams({ from, ...query })}`);
      expect(r.status, await r.clone().text()).toBe(200);
      const text = await r.text();
      return { text, body: facetResponseSchema.parse(JSON.parse(text)) };
    };
    const ids = async (bearer: string, q: string) => {
      const r = await v1(bearer, `/events?${new URLSearchParams({ q, from, limit: '100' })}`);
      expect([200, 422], `${q}: ${await r.clone().text()}`).toContain(r.status);
      if (r.status === 422) return [];
      return ((await r.json()).data as { id: string }[]).map((e) => e.id).sort();
    };

    // Contrast: without the mask the address is visible as the name.
    expect((await facets(unmasked.secret, { field: 'actor.name' })).text).toMatch(ADDRESS);
    const key = fieldMaskKey(env.BETTER_AUTH_SECRET);
    // The email's own pseudonym when the name contains the email; an address only as the name hashes its normalised self.
    const pseudonym = {
      lina: maskedEmail(project.id, 'lina@example.invalid', key),
      ada: maskedEmail(project.id, 'ada@example.invalid', key),
      solo: maskedEmail(project.id, 'solo@example.invalid', key),
    };

    for (const bearer of [masked.secret, token]) {
      // Values: each address-carrying name is one pseudonym group (Lina's two variants together), the ordinary name stays.
      const byName = await facets(bearer, { field: 'actor.name' });
      expect(byName.text).not.toMatch(ADDRESS);
      expect(byName.text).not.toMatch(/Ada\b/);
      const pseudonyms = byName.body.values.filter((v) => /^masked:[0-9a-f]{24}$/.test(v.value));
      expect(Object.fromEntries(pseudonyms.map((v) => [v.value, v.count]))).toEqual({ [pseudonym.lina]: 2, [pseudonym.ada]: 1, [pseudonym.solo]: 1 });
      expect(byName.body.values.some((v) => v.value === 'Omar Q')).toBe(true);
      // The facet pseudonyms are byte-identical to the ones the events carry.
      const actor = async (id: string) => (await (await v1(bearer, `/events?${new URLSearchParams({ q: `id:${id}`, from })}`)).json()).data[0].actor;
      expect(await actor('qa-mask-1')).toMatchObject({ name: pseudonym.lina, email: pseudonym.lina });
      expect(await actor('qa-mask-4')).toMatchObject({ name: pseudonym.ada, email: pseudonym.ada });
      expect((await actor('qa-mask-5')).name).toBe(pseudonym.solo);
      // Labels and groups at both levels.
      for (const query of [
        { field: 'actor' } as Record<string, string>,
        { field: 'actor', by: 'actor.name' },
        { field: 'action', by: 'actor.name' },
        { field: 'actor.name', by: 'actor' },
      ])
        expect((await facets(bearer, query)).text, JSON.stringify(query)).not.toMatch(ADDRESS);
      // Filters on actor.name never find the address rows: exact, case variant, prefix and wildcard; nor the pseudonym.
      for (const q of [
        'actor.name:"Lina@example.invalid"',
        'actor.name:"lina@example.invalid"',
        'actor.name:lina*',
        'actor.name:*@example.invalid',
        'actor.name:*example*',
        'actor.name:"Ada <ada@example.invalid>"',
        'actor.name:ada*',
        'actor.name:"solo@example.invalid"',
        'actor.name:solo*',
        ...Object.values(pseudonym).map((value) => `actor.name:"${value}"`),
      ])
        expect(await ids(bearer, q), q).toEqual([]);
      // A free-text address does not match through the name either.
      for (const q of ['lina@example.invalid', 'ada@example.invalid', 'solo@example.invalid']) expect(await ids(bearer, q), q).toEqual([]);
      // Ordinary names still filter.
      expect(await ids(bearer, 'actor.name:"Omar Q"')).toEqual(['qa-mask-3']);
    }

    // Webhook discovery: a masked endpoint cannot select on a hidden name; the unmasked contrast with the same filter can.
    // Discovery reads only up to its watermark (now minus the async-insert flush bound and a margin), so each endpoint scans
    // until its cursor has passed the ingest: an empty result then covers the events, not a scan that stopped before them.
    const ingestedAt = (await webhookCursorClock(prisma)).now;
    const discovered = async (id: string) => {
      for (let attempt = 0; ; attempt++) {
        const endpoint = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } });
        if (endpoint.cursorReceivedAt > ingestedAt) break;
        if (attempt === 120) throw new Error(`Endpoint ${id} did not scan past the ingest`);
        const { now } = await webhookCursorClock(prisma);
        await discoverWebhookDeliveries(clickhouse, endpoint, { now, rollout: new Date(+cursorFrom - 1) });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return (await prisma.webhookDelivery.findMany({ where: { endpointId: id }, select: { eventId: true } })).map((d) => d.eventId).sort();
    };
    const plain = await discovered(plainHook);
    expect(plain).toContain('qa-mask-1');
    expect(plain).not.toContain('qa-mask-3');
    for (const [i, id] of maskedHooks.entries()) expect(await discovered(id), NAME_FILTERS[i]).toEqual([]);
  } finally {
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
    }
    if (organizationId) {
      await step(() => prisma.auditOutbox.deleteMany({ where: { stream: `ws:${organizationId}` } }));
      await step(() => purgeProject(clickhouse, `ws:${organizationId}`));
      await step(() => prisma.organization.delete({ where: { id: organizationId } }));
    }
    await step(() => prisma.user.deleteMany({ where: { id: { in: users } } }));
    if (failures.length) console.error(JSON.stringify({ event: 'qa.facet_mask_escape.cleanup_failed', failures: failures.map(String) }));
  }
}, 300_000);
