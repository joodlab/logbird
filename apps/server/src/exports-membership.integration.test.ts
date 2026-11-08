import { randomUUID } from 'node:crypto';
import { eventFingerprint, exportEvents, normalizeEvent, prepareExport, purgeProject, read } from '@logbird/clickhouse';
import { exportQuerySchema } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ project: '', hold: false, entered: (): void => undefined, resume: Promise.resolve() }));
vi.mock('@logbird/database', async (original) => {
  const db = await original<typeof import('@logbird/database')>();
  return {
    ...db,
    withProjectLock: async (...args: Parameters<typeof db.withProjectLock>) => {
      if (args[0] === gate.project && args[2]?.mode === 'shared' && gate.hold) {
        gate.hold = false;
        gate.entered();
        await gate.resume;
      }
      return db.withProjectLock(...args);
    },
  };
});

import { clickhouse, maintenanceClickhouse } from './clickhouse';
import { releaseExportAdmission, stageExport, validateExportMembership } from './export-outcomes';
import { ingest } from './ingest';

async function fixture() {
  const org = `qa-export-membership-${randomUUID()}`,
    project = `qa-export-membership-${randomUUID()}`;
  const leases: string[] = [];
  await prisma.organization.create({ data: { id: org, name: 'QA Export membership', slug: org, createdAt: new Date() } });
  await prisma.project.create({ data: { id: project, organizationId: org, name: 'QA Export membership', slug: project, retentionDays: 3650 } });
  const stage = async (clock = Date.now(), historical = false) => {
    const id = randomUUID();
    leases.push(id);
    const query = exportQuerySchema.parse({
      format: 'jsonl',
      ...(historical ? { from: '2018-01-01T00:00:00.000Z', to: '2018-02-01T00:00:00.000Z' } : {}),
    });
    const plan = await prepareExport(clickhouse, query, clock);
    const staged = await stageExport({
      id,
      userId: id,
      workspaceId: org,
      projectId: project,
      stream: `ws:${org}`,
      requested: { id: `${id}-requested`, action: 'export.requested' },
      unknown: { id: `${id}-outcome`, action: 'export.outcome_unknown' },
      receivedBefore: new Date(clock),
    });
    return { id, clock, membership: staged.membership, rows: exportEvents(clickhouse, project, query, plan) };
  };
  const cleanup = async () => {
    gate.hold = false;
    await purgeProject(maintenanceClickhouse, project);
    await prisma.ingestReceipt.deleteMany({ where: { projectId: project } });
    await prisma.exportLease.deleteMany({ where: { id: { in: leases } } });
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
    await prisma.organization.deleteMany({ where: { id: org } });
  };
  return { org, project, stage, cleanup };
}
it('keeps exact retries and reconstructed receipts in a later export page after a fixture-only partition merge', async () => {
  // Master approved OPTIMIZE of an empty historical fixture partition only, never the load-test month.
  const partition = '201801';
  expect(
    Number(
      (
        await read<{ n: number }>(
          clickhouse,
          "SELECT count() n FROM system.parts WHERE database=currentDatabase() AND table='events' AND active AND partition={partition:String}",
          { partition },
        )
      )[0]?.n,
    ),
  ).toBe(0);
  const f = await fixture();
  try {
    const events = Array.from({ length: 401 }, (_, index) => ({
      id: `${f.project}-${index.toString().padStart(3, '0')}`,
      action: 'qa.export.member',
      occurredAt: `2018-01-15T12:00:${Math.floor(index / 100)
        .toString()
        .padStart(2, '0')}.${(index % 100).toString().padStart(3, '0')}Z`,
    }));
    expect((await ingest(f.project, events)).accepted).toBe(401);
    const before = await prisma.ingestReceipt.findUniqueOrThrow({ where: { projectId_eventId: { projectId: f.project, eventId: events[300]!.id } } });
    const reconstructedBefore = await prisma.ingestReceipt.findUniqueOrThrow({
      where: { projectId_eventId: { projectId: f.project, eventId: events[301]!.id } },
    });
    const download = await f.stage(Date.now(), true);
    const ids: string[] = [];
    for (let n = 0; n < 200; n++) ids.push(JSON.parse((await download.rows.next()).value!).id);
    // Ordinary retry after page 1; then evict another cache receipt to exercise raw-index reconstruction.
    expect((await ingest(f.project, events[300])).accepted).toBe(1);
    await prisma.ingestReceipt.delete({ where: { projectId_eventId: { projectId: f.project, eventId: events[301]!.id } } });
    expect((await ingest(f.project, events[301])).accepted).toBe(1);
    const reconstructedAfter = await prisma.ingestReceipt.findUniqueOrThrow({
      where: { projectId_eventId: { projectId: f.project, eventId: events[301]!.id } },
    });
    expect(reconstructedAfter.receivedAt).toEqual(reconstructedBefore.receivedAt);
    expect(reconstructedAfter.eventAt).toEqual(reconstructedBefore.eventAt);
    expect(reconstructedAfter.fingerprint).toBe(reconstructedBefore.fingerprint);
    const after = await prisma.ingestReceipt.findUniqueOrThrow({ where: { projectId_eventId: { projectId: f.project, eventId: events[300]!.id } } });
    expect(after.receivedAt).toEqual(before.receivedAt);
    expect(after.fingerprint).toBe(before.fingerprint);
    // Recheck partition ownership immediately before rewriting it.
    expect(
      (await read<{ project_id: string }>(clickhouse, 'SELECT DISTINCT project_id FROM events WHERE toYYYYMM(timestamp)=201801', {})).map(
        (r) => r.project_id,
      ),
    ).toEqual([f.project]);
    await maintenanceClickhouse.command({ query: "OPTIMIZE TABLE events PARTITION '201801' FINAL" });
    for await (const line of download.rows) ids.push(JSON.parse(line).id);
    await validateExportMembership(f.project, download.membership, download.id);
    expect(new Set(ids)).toEqual(new Set(events.map((event) => event.id)));
    expect(ids).toHaveLength(401);
    expect(Number((await read<{ n: number }>(clickhouse, 'SELECT count() n FROM events WHERE project_id={p:String}', { p: f.project }))[0]?.n)).toBe(
      401,
    );
  } finally {
    await f.cleanup();
  }
}, 120_000);
it('accepts paused normalization, genuinely post-fence events and equal-clock events strictly after the registered fence', async () => {
  const f = await fixture();
  let release: () => void = () => undefined;
  let writer: Promise<unknown> | undefined;
  try {
    for (const mode of ['paused', 'post-fence', 'equal-clock'] as const) {
      gate.project = f.project;
      let entered: () => void = () => undefined;
      const paused = new Promise<void>((resolve) => {
        entered = resolve;
      });
      gate.entered = entered;
      gate.resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate.hold = mode === 'paused';
      const inputs = [
        { id: `${f.project}-${mode}-missing`, action: 'qa.export.clock' },
        { id: `${f.project}-${mode}-invalid`, action: 'qa.export.clock', occurredAt: 'not-a-date' },
      ];
      if (mode === 'paused') {
        writer = ingest(f.project, inputs);
        await paused;
      }
      // A fence ahead of the DB clock deterministically exercises equal-ms ordering, without clock sleeps.
      const download = await f.stage(Date.now() + (mode === 'equal-clock' ? 2000 : 0));
      const first = await download.rows.next();
      release();
      if (mode !== 'paused') writer = ingest(f.project, inputs);
      await writer;
      writer = undefined;
      const receipts = await prisma.ingestReceipt.findMany({ where: { projectId: f.project, eventId: { in: inputs.map((input) => input.id) } } });
      expect(receipts).toHaveLength(2);
      for (const receipt of receipts) {
        expect(+receipt.receivedAt).toBeGreaterThan(download.clock);
        expect(receipt.eventAt).toEqual(receipt.receivedAt);
      }
      if (mode === 'equal-clock') expect(+receipts[0]!.receivedAt).toBe(download.clock + 1);
      const ids: string[] = first.done ? [] : [JSON.parse(first.value).id];
      for await (const line of download.rows) ids.push(JSON.parse(line).id);
      expect(ids.some((id) => inputs.some((input) => input.id === id))).toBe(false);
      expect((await prisma.exportLease.findUniqueOrThrow({ where: { id: download.id } })).invalidated).toBe(false);
      await validateExportMembership(f.project, download.membership, download.id);
      // Retries with omitted/invalid occurredAt continue using the first receipt clock and fingerprint.
      expect((await ingest(f.project, inputs)).accepted).toBe(2);
      expect(
        await prisma.ingestReceipt.findMany({
          where: { projectId: f.project, eventId: { in: inputs.map((input) => input.id) } },
          orderBy: { eventId: 'asc' },
        }),
      ).toEqual(receipts.sort((a, b) => a.eventId.localeCompare(b.eventId)));
      await releaseExportAdmission(download.id);
    }
  } finally {
    release();
    await writer;
    await f.cleanup();
  }
}, 120_000);
it('keeps ready replay clocks and invalidates a fence before inserting a previously missing pre-fence receipt', async () => {
  const f = await fixture();
  try {
    const receivedAt = new Date(Date.now() - 5000),
      input = { id: `${f.project}-replay`, action: 'qa.export.replay', occurredAt: 'invalid' };
    const normalized = normalizeEvent(input, { projectId: f.project, receivedAt });
    if (!normalized.ok) throw new Error(normalized.reason);
    await prisma.ingestReceipt.create({
      data: {
        projectId: f.project,
        organizationId: f.org,
        eventId: input.id,
        fingerprint: eventFingerprint(normalized.row),
        receivedAt,
        eventAt: receivedAt,
        claimedAt: null,
      },
    });
    const download = await f.stage();
    expect((await download.rows.next()).done).toBe(true);
    expect((await ingest(f.project, input)).accepted).toBe(1);
    const replay = await prisma.ingestReceipt.findUniqueOrThrow({ where: { projectId_eventId: { projectId: f.project, eventId: input.id } } });
    expect(replay.receivedAt).toEqual(receivedAt);
    expect(replay.eventAt).toEqual(receivedAt);
    expect(replay.confirmedAt).not.toBeNull();
    expect(replay.fingerprint).toBe(eventFingerprint(normalized.row));
    expect((await prisma.exportLease.findUniqueOrThrow({ where: { id: download.id } })).invalidated).toBe(true);
    const stored = (
      await read<{ received_at: string; timestamp: string }>(clickhouse, 'SELECT received_at,timestamp FROM events WHERE project_id={p:String}', {
        p: f.project,
      })
    )[0]!;
    expect(new Date(`${stored.received_at.replace(' ', 'T')}Z`)).toEqual(receivedAt);
    expect(new Date(`${stored.timestamp.replace(' ', 'T')}Z`)).toEqual(receivedAt);
    await expect(validateExportMembership(f.project, download.membership, download.id)).rejects.toMatchObject({ code: 'export_invalidated' });
  } finally {
    await f.cleanup();
  }
}, 90_000);
