import { randomUUID } from 'node:crypto';
import { eventFingerprint, exportEvents, getEvent, insertEvents, normalizeEvent, read, searchEvents } from '@logbird/clickhouse';
import { prisma, pruneIngestReceipts, purgeIngestReceipts, withProjectLock } from '@logbird/database';
import { expect, it } from 'vitest';
import { clickhouse, purgeProjectEvents } from './clickhouse';
import { ingest } from './ingest';

it('immutable ids, retries, concurrent claims, rollups, legacy rows, pending recovery and cursor pages (real services)', async () => {
  const org = randomUUID();
  const project = `immutable-${randomUUID()}`;
  const now = new Date();
  const original = {
    id: 'original',
    action: 'evidence.original',
    occurredAt: now.toISOString(),
    actor: { id: 'actor' },
    metadata: { status: 'pending' },
  };
  await prisma.organization.create({ data: { id: org, name: 'QA Immutable', slug: org, createdAt: now } });
  await prisma.project.create({ data: { id: project, organizationId: org, name: 'QA Immutable', slug: 'immutable' } });
  const counts = async () =>
    (
      await read<{ raw: number; minutes: number; actors: number; attributes: number }>(
        clickhouse,
        `SELECT
    (SELECT count() FROM events WHERE project_id={p:String}) raw,
    (SELECT sum(events) FROM events_by_minute WHERE project_id={p:String}) minutes,
    (SELECT sum(events) FROM entities WHERE project_id={p:String} AND kind='actor') actors,
    (SELECT sum(count) FROM attribute_keys WHERE project_id={p:String}) attributes`,
        { p: project },
      )
    )[0];
  try {
    expect((await ingest(project, original)).ids).toEqual(['original']);
    const before = await counts();
    expect(before).toEqual({ raw: 1, minutes: 1, actors: 1, attributes: 1 });
    expect((await ingest(project, original, 'another SDK')).ids).toEqual(['original']);
    expect(await counts()).toEqual(before);
    const conflicts = await Promise.all(Array.from({ length: 20 }, (_, i) => ingest(project, { ...original, action: `evidence.rewrite${i}` })));
    for (const response of conflicts)
      expect(response).toMatchObject({ accepted: 0, ids: [], rejected: [{ index: 0, reason: 'duplicate_id_conflict' }] });
    expect((await ingest(project, { ...original, occurredAt: new Date(now.getTime() - 1000).toISOString() })).rejected[0]?.reason).toBe(
      'duplicate_id_conflict',
    );
    expect(await counts()).toEqual(before);

    const race = await Promise.all(Array.from({ length: 20 }, (_, i) => ingest(project, { ...original, id: 'race', action: `race.winner${i}` })));
    expect(race.reduce((sum, r) => sum + r.accepted, 0)).toBe(1);
    expect(race.flatMap((r) => r.rejected)).toHaveLength(19);
    const batch = await ingest(project, [
      { id: 'batch', action: 'batch.original' },
      { id: 'batch', action: 'batch.original' },
      { id: 'batch', action: 'batch.conflict' },
      { action: 'generated.id' },
    ]);
    expect(batch.accepted).toBe(3);
    expect(batch.rejected).toEqual([{ index: 2, reason: 'duplicate_id_conflict' }]);
    await ingest(project, { id: 'clock', action: 'clock.original' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ingest(project, { id: 'clock', action: 'clock.original' });

    const q = {
      from: new Date(now.getTime() - 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
      limit: 1,
      order: 'asc' as const,
    };
    const pages: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await searchEvents(clickhouse, project, { ...q, cursor });
      expect(page.total).toBe(5);
      pages.push(...page.data.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(pages).toHaveLength(5);
    expect(new Set(pages).size).toBe(5);
    expect((await getEvent(clickhouse, project, 'original'))?.event.action).toBe(original.action);
    const search = await searchEvents(clickhouse, project, { ...q, q: 'action:evidence.original', limit: 100 });
    expect(search.data.map((e) => e.action)).toEqual([original.action]);
    const exported: string[] = [];
    for await (const line of exportEvents(clickhouse, project, { ...q, q: 'action:evidence.original', format: 'jsonl' }))
      exported.push(JSON.parse(line).action);
    expect(exported).toEqual([original.action]);

    // Expired confirmed cache: ClickHouse remains authoritative, even across timestamp partitions.
    await prisma.ingestReceipt.updateMany({ where: { projectId: project }, data: { confirmedAt: new Date(0) } });
    await pruneIngestReceipts(project);
    expect(await prisma.ingestReceipt.count({ where: { projectId: project } })).toBe(0);
    expect((await ingest(project, original)).ids).toEqual(['original']);
    expect((await ingest(project, { ...original, occurredAt: new Date(now.getTime() - 86_400_000).toISOString() })).accepted).toBe(0);
    expect((await counts())?.raw).toBe(5);

    // Existing pre-fix row without any receipt, and recovery after confirmation was lost.
    const legacy = normalizeEvent({ ...original, id: 'legacy' }, { projectId: project, receivedAt: now });
    if (!legacy.ok) throw new Error('Invalid fixture');
    await insertEvents(clickhouse, [legacy.row]);
    expect((await ingest(project, { ...original, id: 'legacy', action: 'legacy.conflict' })).accepted).toBe(0);
    expect((await ingest(project, { ...original, id: 'legacy' })).accepted).toBe(1);
    await prisma.ingestReceipt.update({ where: { projectId_eventId: { projectId: project, eventId: 'legacy' } }, data: { confirmedAt: null } });
    expect((await ingest(project, { ...original, id: 'legacy' })).accepted).toBe(1);

    const pending = normalizeEvent({ id: 'pending', action: 'pending.original' }, { projectId: project, receivedAt: now });
    if (!pending.ok) throw new Error('Invalid fixture');
    await prisma.ingestReceipt.create({
      data: {
        projectId: project,
        organizationId: org,
        eventId: 'pending',
        fingerprint: eventFingerprint(pending.row),
        receivedAt: now,
        eventAt: now,
      },
    });
    await expect(ingest(project, { id: 'pending', action: 'pending.original' })).rejects.toMatchObject({ status: 503, code: 'ingest_pending' });
    expect((await ingest(project, { id: 'pending', action: 'pending.conflict' })).rejected[0]?.reason).toBe('duplicate_id_conflict');
    // Retention cleanup hook only deletes claims inside its cutoff; maintenance owns the lock.
    await withProjectLock(project, () => purgeIngestReceipts(project, new Date(now.getTime() - 1)));
    expect(await prisma.ingestReceipt.count({ where: { projectId: project, eventId: 'pending' } })).toBe(1);
    await ingest(`ws:${org}`, { action: 'workspace.audit' });
  } finally {
    await withProjectLock(project, () => purgeProjectEvents(project));
    await withProjectLock(`ws:${org}`, () => purgeProjectEvents(`ws:${org}`));
    expect(await prisma.ingestReceipt.count({ where: { organizationId: org } })).toBe(0);
    await prisma.organization.delete({ where: { id: org } });
  }
}, 90_000);
