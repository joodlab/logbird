import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import {
  createQueryClickHouseClient,
  exportEvents,
  insertEvents,
  normalizeEvent,
  prepareExport,
  purgeProject,
  searchEvents,
} from '@logbird/clickhouse';
import type { AuditEvent, ExportEvidenceRow } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { expect, it } from 'vitest';

it('matches search in both orders, retains legacy canonical payloads and half-open boundaries across delayed pages', async () => {
  const organizationId = `qa-export-parity-${randomUUID()}`;
  const ch = createClient({
    url: process.env.CLICKHOUSE_URL,
    database: process.env.CLICKHOUSE_DATABASE,
    username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
    request_timeout: 300_000,
    clickhouse_settings: { date_time_input_format: 'best_effort' },
  });
  const restricted = createQueryClickHouseClient();
  const clock = Date.now();
  const range = { from: new Date(clock - 7_200_000).toISOString(), to: new Date(clock).toISOString() };
  let projectId = '';
  try {
    const org = await prisma.organization.create({
      data: { id: organizationId, name: 'QA Export parity', slug: organizationId, createdAt: new Date() },
    });
    const project = await prisma.project.create({ data: { organizationId: org.id, name: 'QA Export parity', slug: randomUUID() } });
    projectId = project.id;
    const payloads = Array.from({ length: 205 }, (_, i) => ({
      id: `equal-${String(i).padStart(3, '0')}`,
      action: 'export.parity',
      occurredAt: new Date(clock - 3_600_000 + 1).toISOString(),
      description: '＝1+1',
      metadata: { index: i },
    }));
    const inclusive = { id: 'inclusive', action: 'export.parity', occurredAt: range.from, description: 'boundary', metadata: { index: -1 } };
    const legacy = {
      id: 'legacy',
      action: 'export.parity',
      occurredAt: new Date(clock - 3_600_000 + 2).toISOString(),
      description: 'first accepted',
      metadata: { version: 'first' },
    };
    const canonical = [...payloads, inclusive, legacy];
    const inputs = [
      ...canonical,
      { ...legacy, description: 'later conflicting legacy', metadata: { version: 'second' } },
      { ...inclusive, id: 'exclusive', occurredAt: range.to },
      { ...inclusive, id: 'before', occurredAt: new Date(clock - 7_200_001).toISOString() },
    ];
    // Direct writes deliberately model pre-fence legacy duplicates, only in this fictional project.
    const rows = inputs.map((event, index) => {
      const normalized = normalizeEvent(event, { projectId, receivedAt: new Date(clock + index) });
      if (!normalized.ok) throw new Error(normalized.reason);
      return normalized.row;
    });
    await insertEvents(ch, rows);
    const results = new Map<string, unknown[]>();
    for (const order of ['asc', 'desc'] as const) {
      let cursor: string | undefined;
      const events: AuditEvent[] = [];
      do {
        const page = await searchEvents(ch, projectId, { ...range, q: 'action:export.parity', order, limit: 200, cursor });
        events.push(...page.data);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(events).toHaveLength(207);
      expect(new Set(events.map((event) => event.id))).toEqual(new Set(canonical.map((event) => event.id)));
      // #62 owns earliest-version arbitration; this PR verifies parity and binding to the selected stored version.
      expect(['first accepted', 'later conflicting legacy']).toContain(events.find((event) => event.id === 'legacy')?.description);
      results.set(order, events);
    }
    const normalized: unknown[] = [];
    for await (const row of exportEvents(ch, projectId, { ...range, q: 'action:export.parity', format: 'jsonl' })) {
      const { exportSchemaVersion, ...event } = JSON.parse(row);
      expect(exportSchemaVersion).toBe(1);
      normalized.push(event);
    }
    expect(normalized).toEqual(results.get('asc'));
    const evidence: ExportEvidenceRow[] = [];
    for await (const row of exportEvents(ch, projectId, { ...range, q: 'action:export.parity', format: 'jsonl-evidence' }))
      evidence.push(JSON.parse(row));
    expect(evidence.map((row) => row.event)).toEqual(normalized);
    for (const row of evidence)
      expect(row.payload).toEqual(inputs.find((event) => event.id === row.event.id && event.description === row.event.description));

    const delayed = exportEvents(
      ch,
      projectId,
      { ...range, format: 'jsonl', q: 'occurredAt:>now-1h' },
      await prepareExport(ch, { ...range, format: 'jsonl', q: 'occurredAt:>now-1h' }, clock),
    );
    const delayedRows: string[] = [];
    for (let i = 0; i < 200; i++) delayedRows.push((await delayed.next()).value as string);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for await (const row of delayed) delayedRows.push(row);
    expect(delayedRows).toHaveLength(206);
    if (restricted) {
      const query = { ...range, format: 'jsonl-evidence' as const, lang: 'sql' as const, q: "timestamp > now64(3, 'UTC') - INTERVAL 1 HOUR" };
      const plan = await prepareExport(restricted, query, clock);
      const sqlRows: ExportEvidenceRow[] = [];
      for await (const row of exportEvents(restricted, projectId, query, plan)) sqlRows.push(JSON.parse(row));
      expect(sqlRows).toHaveLength(206);
      for (const row of sqlRows)
        expect(row.payload).toEqual(inputs.find((event) => event.id === row.event.id && event.description === row.event.description));
    }
    // The legacy path can contain conflicts with identical id, occurrence AND receive times.
    // Whatever physical version the query selects, its payload must come from that same row.
    const tied = ['tie-a', 'tie-b'].map((description) => {
      const result = normalizeEvent(
        { id: 'legacy-tie', action: 'export.tie', occurredAt: new Date(clock - 1000).toISOString(), description },
        { projectId, receivedAt: new Date(clock + 1000) },
      );
      if (!result.ok) throw new Error(result.reason);
      return result.row;
    });
    await insertEvents(ch, tied);
    const tiedEvidence: ExportEvidenceRow[] = [];
    for await (const row of exportEvents(ch, projectId, { ...range, q: 'action:export.tie', format: 'jsonl-evidence' }))
      tiedEvidence.push(JSON.parse(row));
    expect(tiedEvidence).toHaveLength(1);
    expect(['tie-a', 'tie-b']).toContain(tiedEvidence[0]?.event.description);
    expect(tiedEvidence[0]?.payload).toMatchObject({ description: tiedEvidence[0]?.event.description });
  } finally {
    if (projectId) await purgeProject(ch, projectId);
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await restricted?.close();
    await ch.close();
  }
}, 360_000);
