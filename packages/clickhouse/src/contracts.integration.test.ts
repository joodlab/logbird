// Database schema is a prerequisite. Tests never migrate implicitly: opt in with
// CLICKHOUSE_TEST_MIGRATE=1, or deploy schema in a separately coordinated command.
import { randomUUID } from 'node:crypto';
import {
  entityListResponseSchema,
  entityProfileSchema,
  eventDetailSchema,
  eventSchema,
  facetResponseSchema,
  fieldsResponseSchema,
  histogramResponseSchema,
  overviewResponseSchema,
  searchResponseSchema,
} from '@logbird/contracts';
import { expect, it } from 'vitest';
import {
  createClickHouseClient,
  entityProfile,
  exportEvents,
  facets,
  getEvent,
  histogram,
  insertEvents,
  listEntities,
  listFields,
  liveEvents,
  migrate,
  normalizeEvent,
  operationEvents,
  overview,
  projectStats,
  purgeProject,
  searchEvents,
} from './index';

it.runIf(process.env.CLICKHOUSE_URL)(
  'real ClickHouse: contracts, pagination, tenancy, rollups and purge',
  async () => {
    const ch = createClickHouseClient(),
      p = `test-${randomUUID()}`,
      other = `test-${randomUUID()}`,
      now = new Date(),
      from = new Date(now.getTime() - 3_600_000).toISOString(),
      to = new Date(now.getTime() + 1000).toISOString();
    const input = {
      action: 'hotel.updated',
      occurredAt: new Date(now.getTime() - 10_000).toISOString(),
      actor: { id: 'u', name: 'Demo', type: 'user', email: 'demo@example.test' },
      impersonator: { id: 'support' },
      executor: { id: 'crm', name: 'CRM worker', type: 'worker', jobId: 'job-1' },
      tenant: { id: 'biz', name: 'Example' },
      targets: [{ type: 'hotel', id: 'h', name: 'Hotel' }],
      metadata: { plan: 'pro' },
      context: { operationId: 'op' },
    };
    try {
      if (process.env.CLICKHOUSE_TEST_MIGRATE === '1') await migrate(ch);
      for (const projectId of [p, other]) {
        const rows = [
          { ...input, id: 'root', occurredAt: new Date(now.getTime() - 20_000).toISOString() },
          { ...input, id: 'child', context: { operationId: 'op', parentEventId: 'root' }, outcome: 'failure' },
        ].map((e) => normalizeEvent(e, { projectId, receivedAt: now }));
        await insertEvents(
          ch,
          rows.flatMap((r) => (r.ok ? [r.row] : [])),
        );
      }
      const arrived = await liveEvents(ch, p, { since: new Date(now.getTime() - 1000).toISOString(), limit: 20 });
      expect(arrived.map((e) => e.id).sort()).toEqual(['child', 'root']);
      for (const [field, label] of [
        ['actor', 'Demo'],
        ['tenant', 'Example'],
        ['executor', 'CRM worker'],
        ['target', 'Hotel'],
      ]) {
        const result = await facets(ch, p, { from, to, field: field ?? 'actor', limit: 10 });
        expect(result.values[0]?.label).toBe(label);
        expect(result.values[0]?.count).toBe(2);
      }
      for (const query of [
        'impersonator:support',
        'actor.email:demo@example.test',
        'tenant.name:Example',
        'executor.name:"CRM worker"',
        'job:job-1',
        'parent:root OR id:root',
      ]) {
        expect((await searchEvents(ch, p, { from, to, q: query, limit: 20, order: 'desc' })).total).toBe(2);
      }
      const empty = await histogram(ch, p, { from: '2020-01-01T00:00:00Z', to: '2020-01-01T00:03:00Z', interval: 60 });
      expect(empty.buckets.map((b) => b.total)).toEqual([0, 0, 0]);
      const q = { from, to, limit: 1, order: 'desc' as const };
      const page = searchResponseSchema.parse(await searchEvents(ch, p, q));
      expect(page.total).toBe(2);
      expect(page.data).toHaveLength(1);
      expect(page.nextCursor).toBeTruthy();
      const second = await searchEvents(ch, p, { ...q, cursor: page.nextCursor ?? undefined });
      expect(second.data[0]?.id).not.toBe(page.data[0]?.id);
      expect(second.nextCursor).toBeNull();
      const detail = eventDetailSchema.parse(await getEvent(ch, p, 'child'));
      expect(detail.parents.map((e) => e.id)).toEqual(['root']);
      expect(detail.operationSize).toBe(2);
      expect((await getEvent(ch, p, 'root'))?.childCount).toBe(1);
      expect(await getEvent(ch, p, 'missing')).toBeNull();
      for (const e of await liveEvents(ch, p, { since: from, limit: 20 })) eventSchema.parse(e);
      expect(histogramResponseSchema.parse(await histogram(ch, p, { from, to })).buckets.reduce((n, b) => n + b.total, 0)).toBe(2);
      expect(facetResponseSchema.parse(await facets(ch, p, { from, to, field: 'action', limit: 10 })).values[0]?.count).toBe(2);
      expect(overviewResponseSchema.parse(await overview(ch, p, { from, to })).kpis.events).toBe(2);
      expect(entityListResponseSchema.parse(await listEntities(ch, p, { kind: 'actor', limit: 25 })).data[0]?.events).toBe(2);
      expect(entityProfileSchema.parse(await entityProfile(ch, p, 'actor', 'u', { from, to })).outcomes.failure).toBe(1);
      expect(fieldsResponseSchema.parse(await listFields(ch, p, { from, to })).data.some((f) => f.key === 'attr.metadata.plan')).toBe(true);
      expect(await operationEvents(ch, p, 'op')).toHaveLength(2);
      const lines: unknown[] = [];
      for await (const line of exportEvents(ch, p, { from, to, format: 'jsonl' })) lines.push(JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect((await projectStats(ch, [p, other]))[p]?.eventsLast24h).toBe(2);
      await purgeProject(ch, p, new Date(now.getTime() - 15_000));
      expect((await listEntities(ch, p, { kind: 'actor', limit: 25 })).data[0]?.events).toBe(1);
      expect((await overview(ch, p, { from, to })).kpis.events).toBe(1);
      await purgeProject(ch, p);
      expect((await searchEvents(ch, p, q)).total).toBe(0);
      expect((await searchEvents(ch, other, q)).total).toBe(2);
      expect((await listEntities(ch, p, { kind: 'actor', limit: 25 })).data).toEqual([]);
    } finally {
      await purgeProject(ch, p);
      await purgeProject(ch, other);
      await ch.close();
    }
  },
  // Two body purges plus two finally purges (~20 s/events deletion on the shared 2-slot pool); measured 96.6 s with passing assertions.
  180_000,
);

it.runIf(process.env.CLICKHOUSE_URL)(
  'live tail dedupes event IDs across late event timestamps',
  async () => {
    const ch = createClickHouseClient();
    const p = `test-live-${randomUUID()}`;
    const receivedAt = new Date();
    try {
      for (const occurredAt of ['2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z']) {
        const normalized = normalizeEvent({ id: 'same-id', action: 'late.event', occurredAt }, { projectId: p, receivedAt });
        if (!normalized.ok) throw new Error(normalized.reason);
        await insertEvents(ch, [normalized.row]);
      }
      const result = await liveEvents(ch, p, { since: new Date(receivedAt.getTime() - 1000).toISOString(), limit: 20 });
      expect(result.map((event) => event.id)).toEqual(['same-id']);
      const empty = await liveEvents(ch, p, { since: new Date(receivedAt.getTime() + 1000).toISOString(), limit: 20 });
      expect(empty).toEqual([]);
    } finally {
      await purgeProject(ch, p);
      await ch.close();
    }
  },
  60_000,
);

it.runIf(process.env.CLICKHOUSE_URL)(
  'field:* matches only events where the field is present',
  async () => {
    const ch = createClickHouseClient();
    const p = `test-presence-${randomUUID()}`;
    const now = Date.now();
    const from = new Date(now - 3_600_000).toISOString(),
      to = new Date(now + 1000).toISOString();
    try {
      const events = [
        { id: 'a', action: 'x', actor: { id: 'u1' }, impersonator: { id: 'support' }, metadata: { plan: 'pro' }, context: { parentEventId: 'c' } },
        { id: 'b', action: 'x', actor: { id: 'u1' }, executor: { id: 'w', jobId: '7' }, metadata: { plan: '' } },
        { id: 'c', action: 'x', tenant: { id: 't1' }, targets: [{ type: 'hotel', id: 'h1' }] },
      ];
      await insertEvents(
        ch,
        events.flatMap((e, i) => {
          const r = normalizeEvent({ ...e, occurredAt: new Date(now - 10_000 - i).toISOString() }, { projectId: p, receivedAt: new Date(now) });
          return r.ok ? [r.row] : [];
        }),
      );
      const ids = async (q: string) => (await searchEvents(ch, p, { from, to, q, limit: 20, order: 'desc' })).data.map((e) => e.id).sort();
      expect(await ids('impersonator:*')).toEqual(['a']);
      expect(await ids('-impersonator:*')).toEqual(['b', 'c']);
      expect(await ids('actor:*')).toEqual(['a', 'b']);
      expect(await ids('tenant:*')).toEqual(['c']);
      expect(await ids('executor:*')).toEqual(['b']);
      expect(await ids('job:*')).toEqual(['b']);
      expect(await ids('parent:*')).toEqual(['a']);
      expect(await ids('target:*')).toEqual(['c']);
      expect(await ids('attr.metadata.plan:*')).toEqual(['a']);
      expect(await ids('impersonator:sup*')).toEqual(['a']);
    } finally {
      await purgeProject(ch, p);
      await ch.close();
    }
  },
  60_000,
);

it.runIf(process.env.CLICKHOUSE_URL)(
  'entity directories order by activity and page without gaps for every sort',
  async () => {
    const ch = createClickHouseClient();
    const p = `test-entities-${randomUUID()}`;
    const now = Date.now();
    // u3 is the most active; u1/u2 tie on events and are separated by recency; names reverse the id order.
    const plan: [string, string, number, number][] = [
      ['u1', 'Zed', 2, 50_000],
      ['u2', 'Yara', 2, 20_000],
      ['u3', 'Xavier', 5, 40_000],
      ['u4', 'Wanda', 1, 10_000],
      ['u5', '', 1, 30_000],
    ];
    try {
      const rows = plan.flatMap(([id, name, count, age]) =>
        Array.from({ length: count }, (_, i) => {
          const r = normalizeEvent(
            { id: `${id}-${i}`, action: 'x', occurredAt: new Date(now - age - i * 1000).toISOString(), actor: { id, name, type: 'user' } },
            { projectId: p, receivedAt: new Date(now) },
          );
          if (!r.ok) throw new Error(r.reason);
          return r.row;
        }),
      );
      await insertEvents(ch, rows);
      const all = async (sort: 'events' | 'lastSeen' | 'name') => {
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = entityListResponseSchema.parse(await listEntities(ch, p, { kind: 'actor', limit: 2, sort, cursor }));
          seen.push(...page.data.map((e) => e.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return seen;
      };
      expect(await all('events')).toEqual(['u3', 'u2', 'u1', 'u4', 'u5']);
      expect(await all('lastSeen')).toEqual(['u4', 'u2', 'u5', 'u3', 'u1']);
      expect(await all('name')).toEqual(['u5', 'u4', 'u3', 'u2', 'u1']);
      expect((await listEntities(ch, p, { kind: 'actor', limit: 25 })).data.map((e) => e.id)).toEqual(['u3', 'u2', 'u1', 'u4', 'u5']);
      const first = await listEntities(ch, p, { kind: 'actor', limit: 2, sort: 'events' });
      await expect(listEntities(ch, p, { kind: 'actor', limit: 2, sort: 'name', cursor: first.nextCursor ?? '' })).rejects.toThrow('Invalid cursor');
    } finally {
      await purgeProject(ch, p);
      await ch.close();
    }
  },
  60_000,
);

it.runIf(process.env.CLICKHOUSE_URL)(
  'entity search ranks an exact id, then id prefix, name prefix, substring and fuzzy, before activity',
  async () => {
    const ch = createClickHouseClient();
    const p = `test-entity-search-${randomUUID()}`;
    const now = Date.now();
    let n = 0;
    const event = (
      count: number,
      e: { tenant?: { id: string; name?: string }; actor?: { id: string; name?: string }; targets?: { type: string; id: string; name?: string }[] },
    ) =>
      Array.from({ length: count }, () => {
        n += 1;
        const r = normalizeEvent(
          { id: `e${n}`, action: 'x', occurredAt: new Date(now - n * 1000).toISOString(), actor: { id: 'u', type: 'user' }, ...e },
          { projectId: p, receivedAt: new Date(now) },
        );
        if (!r.ok) throw new Error(r.reason);
        return r.row;
      });
    try {
      await insertEvents(ch, [
        // The searched-for tenant is quiet and unnamed; busier near-matches must not push it out of a short list.
        ...event(1, { tenant: { id: 'biz_27' } }),
        ...event(2, { tenant: { id: 'biz_270', name: 'Rimal Crescent' } }),
        ...event(9, { tenant: { id: 'biz_2', name: 'Rawda Suites' } }),
        ...event(8, { tenant: { id: 'biz_7', name: 'Marsa Lantern Suites' } }),
        ...event(7, { tenant: { id: 'biz_1', name: 'Dar Al Wafa' } }),
        ...event(6, { tenant: { id: 'biz_3', name: 'Qamar Dunes' } }),
        ...event(9, { actor: { id: 'crm-hourly-biz_7', name: 'Hourly scheduler - Marsa Lantern Suites' } }),
        ...event(1, { actor: { id: 'usr_131', name: 'Sophie Patel' } }),
        ...event(9, { actor: { id: 'usr_1', name: 'Noura Al-Harbi' } }),
        ...event(8, { actor: { id: 'usr_13', name: 'Omar Kapoor' } }),
        ...event(1, { targets: [{ type: 'article', id: 'article_27_2', name: 'Umrah Season Packages' }] }),
        ...event(9, { targets: [{ type: 'website', id: 'web_27_2', name: 'darb-pearl-residences.example.com' }] }),
        ...event(9, { targets: [{ type: 'article', id: 'article_1_2', name: 'Umrah Packages' }] }),
        // Colons: tenants whose ids merely end in `biz_27` are not it; a record type may itself contain a colon.
        ...['a', 'b', 'c', 'd'].flatMap((x) => event(5, { tenant: { id: `${x}:biz_27` } })),
        ...event(1, { targets: [{ type: 'catalog:item', id: 'item_99_1', name: 'Catalog item' }] }),
        ...event(9, { targets: [{ type: 'post', id: 'item_99_10', name: 'Busier post' }] }),
      ]);
      const ids = async (kind: 'actor' | 'tenant' | 'target', q: string, limit = 4) =>
        entityListResponseSchema.parse(await listEntities(ch, p, { kind, q, limit })).data.map((e) => e.id);
      // Exact id first, whatever the activity and the cap; an id prefix next.
      expect((await ids('tenant', 'biz_27')).slice(0, 2)).toEqual(['biz_27', 'biz_270']);
      expect(await ids('tenant', 'BIZ_27', 1)).toEqual(['biz_27']);
      expect(await ids('actor', 'usr_131', 1)).toEqual(['usr_131']);
      // Only a record loses its own type prefix: four busier `x:biz_27` tenants never push out the exact `biz_27`.
      expect(await ids('tenant', 'biz_27', 1)).toEqual(['biz_27']);
      expect(await ids('target', 'item_99_1', 1)).toEqual(['catalog:item:item_99_1']);
      // Targets are stored as type:id; the bare id is an exact match too.
      expect(await ids('target', 'article_27_2', 1)).toEqual(['article:article_27_2']);
      // A name prefix beats a busier entity that only contains the words.
      expect(await ids('tenant', 'Marsa', 1)).toEqual(['biz_7']);
      expect(await ids('actor', 'marsa')).toContain('crm-hourly-biz_7');
      // One or two characters match only what starts with them (ids, a record's bare id, names), exact first.
      expect(await ids('tenant', 'bi')).toEqual(expect.arrayContaining(['biz_2']));
      expect(await ids('tenant', 'Ma', 1)).toEqual(['biz_7']);
      expect(await ids('actor', 'rs')).toEqual([]);
      // Without a search, the directory order is unchanged (most active first).
      expect((await listEntities(ch, p, { kind: 'tenant', limit: 2 })).data.map((e) => e.id)).toEqual(['biz_2', 'biz_7']);
      // A search pages by rank, then activity, without gaps or repeats; its cursor only fits a search.
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = entityListResponseSchema.parse(await listEntities(ch, p, { kind: 'tenant', q: 'biz_2', limit: 1, cursor }));
        seen.push(...page.data.map((e) => e.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      // biz_2 is exact; biz_270 and biz_27 are id prefixes, so the busier one comes first.
      expect(seen.slice(0, 3)).toEqual(['biz_2', 'biz_270', 'biz_27']);
      expect(new Set(seen).size).toBe(seen.length);
      const searched = await listEntities(ch, p, { kind: 'tenant', q: 'biz', limit: 1 });
      await expect(listEntities(ch, p, { kind: 'tenant', limit: 1, cursor: searched.nextCursor ?? '' })).rejects.toThrow('Invalid cursor');
    } finally {
      await purgeProject(ch, p);
      await ch.close();
    }
  },
  60_000,
);
