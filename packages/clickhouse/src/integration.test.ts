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
} from '@trailmark/contracts';
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
      await migrate(ch);
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
  60_000,
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
