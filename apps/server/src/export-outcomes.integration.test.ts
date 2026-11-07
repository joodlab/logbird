import { randomUUID } from 'node:crypto';
import { auditNamespace, prisma } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import { finishExport, releaseExport, stageExport, sweepExportOutcomes } from './export-outcomes';
import { drainAuditOutbox } from './outbox-delivery';

it('atomically reserves terminal evidence, recovers write failures/crashes, and bounds replica admission', async () => {
  const ids: string[] = [];
  const namespace = auditNamespace();
  const organizationId = `qa-export-outcome-${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: 'QA Export outcome recovery', slug: organizationId, createdAt: new Date() } });
  const projects = await prisma.project.createManyAndReturn({
    data: [0, 1, 2].map((index) => ({ organizationId, name: `QA Export outcome ${index}`, slug: `outcome-${index}` })),
  });
  const make = () => {
    const id = randomUUID();
    ids.push(id);
    const project = projects[ids.length % projects.length];
    if (!project) throw new Error('Fictional project missing');
    return {
      id,
      userId: `qa-export-${id}`,
      workspaceId: `qa-export-${id}`,
      projectId: project.id,
      stream: `ws:qa-export-${id}`,
      requested: { id: `${id}-requested`, action: 'export.requested' },
      unknown: { id: `${id}-outcome`, action: 'export.outcome_unknown' },
    };
  };
  try {
    const rollback = make();
    await expect(stageExport({ ...rollback, unknown: { ...rollback.unknown, id: rollback.requested.id } })).rejects.toThrow();
    expect(await prisma.auditOutbox.count({ where: { stream: rollback.stream } })).toBe(0);
    expect(await prisma.exportLease.count({ where: { id: rollback.id } })).toBe(0);

    const recovered = make();
    await stageExport(recovered);
    const failure = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('fictional update outage'));
    await finishExport(recovered.id, recovered.stream, { action: 'export.completed', metadata: { rows: 205 } });
    failure.mockRestore();
    // Drafts cannot race ingestion or cancellation: they are invisible until settlement.
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: `${recovered.id}-outcome` } })).confirmedAt).toBeNull();
    await releaseExport(recovered.id, 'export.completed');
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: `${recovered.id}-outcome` } })).payload).toMatchObject({
      action: 'export.completed',
      metadata: { rows: 205 },
    });

    const lost = make();
    await stageExport(lost);
    const outage = vi.spyOn(prisma, '$transaction').mockRejectedValue(new Error('fictional persistent outage'));
    try {
      await finishExport(lost.id, lost.stream, { action: 'export.completed' });
    } finally {
      outage.mockRestore();
    }
    await releaseExport(lost.id, 'export.completed');
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: `${lost.id}-outcome` } })).payload).toMatchObject({
      action: 'export.outcome_unknown',
    });

    const crashed = make();
    await stageExport(crashed);
    await finishExport(crashed.id, crashed.stream, { action: 'export.completed' });
    await sweepExportOutcomes(new Date(Date.now() + 61_000));
    const unknown = await prisma.auditOutbox.findUniqueOrThrow({ where: { id: `${crashed.id}-outcome` } });
    expect(unknown.payload).toMatchObject({ action: 'export.outcome_unknown' });
    expect(unknown.confirmedAt).not.toBeNull();
    expect(unknown.pendingOutcome).toBeNull();

    const canceled = make();
    await stageExport(canceled);
    await finishExport(canceled.id, canceled.stream, { action: 'export.completed' });
    // Even if storing the cancellation failed, settlement must not confirm that completed draft.
    await releaseExport(canceled.id, 'export.failed');
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: `${canceled.id}-outcome` } })).payload).toMatchObject({
      action: 'export.outcome_unknown',
    });

    const active = make();
    await stageExport(active);
    await expect(stageExport({ ...make(), userId: active.userId })).rejects.toMatchObject({ code: 'export_busy' });
    const second = make();
    await stageExport(second);
    await expect(stageExport(make())).rejects.toMatchObject({ code: 'export_busy' });
    await releaseExport(active.id, 'export.failed');
    await releaseExport(second.id, 'export.failed');
    const admitted = make();
    await stageExport(admitted);
    await releaseExport(admitted.id, 'export.failed');
    const sql = make();
    await stageExport({ ...sql, sql: true });
    await expect(stageExport(make())).rejects.toMatchObject({ code: 'export_busy' });
    await releaseExport(sql.id, 'export.failed');
    const competitors = [make(), make(), make()];
    const admittedTogether = await Promise.allSettled(competitors.map((input) => stageExport(input)));
    expect(admittedTogether.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(admittedTogether.filter((result) => result.status === 'rejected')).toHaveLength(1);
    for (const input of competitors) await releaseExport(input.id, 'export.failed');

    const delivered: string[] = [];
    while (
      await drainAuditOutbox(async (_stream, event) => {
        delivered.push(event.action);
        return { accepted: 1, rejected: [] };
      })
    ) {
      /* drain test namespace */
    }
    expect(delivered).toContain('export.outcome_unknown');
    expect(delivered).toContain('export.completed');
  } finally {
    vi.restoreAllMocks();
    await prisma.auditOutbox.deleteMany({ where: { namespace, stream: { in: ids.map((id) => `ws:qa-export-${id}`) } } });
    await prisma.exportLease.deleteMany({ where: { namespace, id: { in: ids } } });
    await prisma.organization.delete({ where: { id: organizationId } });
  }
});
