import { randomUUID } from 'node:crypto';
import { maintenanceQueryPrefix, projectMaintenance, purgeProject, read } from '@logbird/clickhouse';
import { closeProjectLocks, prisma, withProjectLock } from '@logbird/database';
import { afterAll, expect, it, vi } from 'vitest';
import { clickhouse, maintenanceClickhouse, queryClickhouse } from './clickhouse';
import { beginDestructiveMaintenance, reconcileDestructiveMaintenance } from './destructive-maintenance';
import { stageExport, validateExportMembership } from './export-outcomes';
import { ingest } from './ingest';
import { removeSampleData } from './sample-data';

afterAll(async () => {
  await closeProjectLocks();
  await Promise.all([clickhouse.close(), maintenanceClickhouse.close(), queryClickhouse?.close(), prisma.$disconnect()]);
});

it('keeps newly admitted exports refused across an orphaned tagged query and queued raw DELETE mutation', async () => {
  const id = `qa-destructive-${randomUUID()}`;
  const ids: string[] = [];
  let orphan: Promise<unknown> | undefined;
  const stage = async () => {
    const exportId = randomUUID();
    ids.push(exportId);
    const staged = await stageExport({
      id: exportId,
      projectId: id,
      userId: exportId,
      workspaceId: id,
      stream: `ws:${id}`,
      requested: { action: 'export.requested', id: `${exportId}-requested` },
      unknown: { action: 'export.outcome_unknown', id: `${exportId}-outcome` },
    });
    return { ...staged, id: exportId };
  };
  await prisma.organization.create({ data: { id, name: 'QA Destructive fence', slug: id, createdAt: new Date() } });
  await prisma.project.create({ data: { id, name: 'QA Destructive fence', slug: id, organizationId: id, retentionDays: 3650 } });
  try {
    expect((await ingest(id, [{ id: `${id}-one`, action: 'qa.fence', occurredAt: '2018-01-15T00:00:00.000Z' }])).accepted).toBe(1);
    // A claim beyond the 60 s lease + 10 s flush bound must not disable exports indefinitely.
    await prisma.ingestReceipt.updateMany({ where: { projectId: id }, data: { confirmedAt: null, claimedAt: new Date(Date.now() - 71_000) } });
    const initial = await stage();
    expect(initial.membership).not.toBeNull();
    await withProjectLock(id, () => beginDestructiveMaintenance(id));
    const unavailable = vi.spyOn(maintenanceClickhouse, 'query').mockRejectedValueOnce(new Error('QA CH unavailable'));
    await expect(withProjectLock(id, () => reconcileDestructiveMaintenance(id))).rejects.toThrow('QA CH unavailable');
    unavailable.mockRestore();
    expect((await prisma.project.findUniqueOrThrow({ where: { id } })).exportDeleteStartedAt).not.toBeNull();
    // The caller has released its lock, but ClickHouse is still running its tagged work.
    orphan = projectMaintenance(maintenanceClickhouse, id)
      .query({ query: 'SELECT sleep(3)', format: 'JSONEachRow' })
      .then((r) => r.json());
    await vi.waitFor(async () => {
      expect(
        Number(
          (
            await read<{ n: number }>(clickhouse, 'SELECT count() n FROM system.processes WHERE startsWith(query_id,{prefix:String})', {
              prefix: maintenanceQueryPrefix(id),
            })
          )[0]?.n,
        ),
      ).toBeGreaterThan(0);
    });
    expect(await withProjectLock(id, () => reconcileDestructiveMaintenance(id))).toBe(false);
    expect((await stage()).membership).toBeNull();
    await expect(validateExportMembership(id, initial.membership, initial.id)).rejects.toMatchObject({ code: 'export_invalidated' });
    await orphan;
    // Submit asynchronously, then lose the caller's outcome. No global merge controls or shared settings are changed.
    await projectMaintenance(maintenanceClickhouse, id).command({
      query: 'DELETE FROM events WHERE project_id={p:String} AND toYYYYMM(timestamp)=201801 AND sleep(3)=0',
      query_params: { p: id },
      clickhouse_settings: { mutations_sync: '0', lightweight_deletes_sync: '0', allow_nondeterministic_mutations: 1 },
    });
    const pending = await read<{ command: string }>(
      clickhouse,
      "SELECT command FROM system.mutations WHERE database=currentDatabase() AND table='events' AND is_done=0 AND position(command,{p:String})>0",
      { p: id },
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(await withProjectLock(id, () => reconcileDestructiveMaintenance(id))).toBe(false);
    expect((await stage()).membership).toBeNull();
    await vi.waitFor(
      async () => {
        expect(await withProjectLock(id, () => reconcileDestructiveMaintenance(id))).toBe(true);
      },
      { timeout: 30_000, interval: 100 },
    );
    expect(Number((await read<{ n: number }>(clickhouse, 'SELECT count() n FROM events WHERE project_id={p:String}', { p: id }))[0]?.n)).toBe(0);
    expect((await prisma.project.findUniqueOrThrow({ where: { id } })).exportDeleteStartedAt).toBeNull();
    const recovered = await stage();
    expect(recovered.membership).not.toBeNull();
    await validateExportMembership(id, recovered.membership, recovered.id);
  } finally {
    await orphan?.catch(() => undefined);
    await purgeProject(maintenanceClickhouse, id);
    for (const table of ['events', 'event_ids', 'events_by_minute', 'entities', 'attribute_keys']) {
      expect(Number((await read<{ n: number }>(clickhouse, `SELECT count() n FROM ${table} WHERE project_id={p:String}`, { p: id }))[0]?.n)).toBe(0);
    }
    await prisma.ingestReceipt.deleteMany({ where: { projectId: id } });
    await prisma.exportLease.deleteMany({ where: { id: { in: ids } } });
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${id}` } });
    await prisma.organization.delete({ where: { id } });
    expect(await prisma.ingestReceipt.count({ where: { projectId: id } })).toBe(0);
    expect(await prisma.auditOutbox.count({ where: { stream: `ws:${id}` } })).toBe(0);
  }
}, 120_000);

it('persists the sample-removal fence before its raw delete even if the caller dies before creating a repair run', async () => {
  const id = `qa-sample-fence-${randomUUID()}`;
  await prisma.organization.create({ data: { id, name: 'QA Sample fence', slug: id, createdAt: new Date() } });
  await prisma.project.create({ data: { id, name: 'QA Sample fence', slug: id, organizationId: id } });
  const command = maintenanceClickhouse.command.bind(maintenanceClickhouse);
  const fault = vi.spyOn(maintenanceClickhouse, 'command').mockImplementation(async (args) => {
    if (args.query.startsWith('DELETE FROM events')) {
      expect((await prisma.project.findUniqueOrThrow({ where: { id } })).exportDeleteStartedAt).not.toBeNull();
      await command({ ...args, clickhouse_settings: { mutations_sync: '0', lightweight_deletes_sync: '0' } });
      throw new Error('QA caller interrupted after destructive fence');
    }
    return command(args);
  });
  try {
    await expect(withProjectLock(id, () => removeSampleData(id))).rejects.toThrow('QA caller interrupted');
    expect(await prisma.retentionRun.count({ where: { projectId: id } })).toBe(0);
    expect((await prisma.project.findUniqueOrThrow({ where: { id } })).exportDeleteStartedAt).not.toBeNull();
  } finally {
    fault.mockRestore();
    expect(await withProjectLock(id, () => reconcileDestructiveMaintenance(id))).toBe(true);
    await prisma.organization.delete({ where: { id } });
  }
});
