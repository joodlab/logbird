import { randomUUID } from 'node:crypto';
import { auditNamespace, prisma, withProjectLock } from '@logbird/database';
import { expect, it, vi } from 'vitest';
import {
  confirmExportOutcome,
  finishExport,
  releaseExport,
  releaseExportAdmission,
  stageExport,
  sweepExportOutcomes,
  validateExportMembership,
} from './export-outcomes';
import { auditedExport, drainExportAudits } from './export-stream';
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

it('keeps SQL capacity charged after cancellation until the deferred page and iterator settle', async () => {
  const org = `qa-export-cancel-capacity-${randomUUID()}`;
  await prisma.organization.create({ data: { id: org, name: 'QA Export cancel capacity', slug: org, createdAt: new Date() } });
  const project = await prisma.project.create({ data: { organizationId: org, name: 'QA Deferred page', slug: 'deferred-page' } });
  const id = randomUUID(),
    replacement = randomUUID();
  const input = (id: string) => ({
    id,
    userId: id,
    workspaceId: org,
    projectId: project.id,
    stream: `ws:${org}`,
    sql: true,
    requested: { id: `${id}-requested`, action: 'export.requested' },
    unknown: { id: `${id}-outcome`, action: 'export.outcome_unknown' },
  });
  let unblock!: () => void, entered!: () => void, confirmed!: () => void;
  const page = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const frozen = new Promise<void>((resolve) => {
    confirmed = resolve;
  });
  const abort = new AbortController();
  try {
    async function* source() {
      yield '{}\n';
      entered();
      await page;
      yield '{}\n';
    }
    const body = await auditedExport(
      source(),
      false,
      async (action, counts) => {
        if (action === 'export.requested') await stageExport(input(id));
        else await finishExport(id, `ws:${org}`, { action, metadata: { export: counts } });
      },
      abort.signal,
      id,
      {
        onTerminal: async (action) => {
          await confirmExportOutcome(id, action);
          confirmed();
        },
        onSettled: () => releaseExportAdmission(id),
      },
    );
    const reader = body.getReader();
    await reader.read();
    const next = reader.read();
    await started;
    abort.abort();
    await expect(next).rejects.toThrow('Export aborted');
    await frozen;
    expect((await prisma.auditOutbox.findUniqueOrThrow({ where: { id: `${id}-outcome` } })).payload).toMatchObject({ action: 'export.failed' });
    expect(await prisma.exportLease.count({ where: { id } })).toBe(1);
    await expect(stageExport(input(replacement))).rejects.toMatchObject({ code: 'export_busy' });
    unblock();
    await drainExportAudits();
    await expect(stageExport(input(replacement))).resolves.toBeTruthy();
  } finally {
    unblock();
    abort.abort();
    await drainExportAudits();
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
    await prisma.exportLease.deleteMany({ where: { projectId: project.id } });
    await prisma.organization.delete({ where: { id: org } });
  }
});

it('bounds both exclusive export boundaries and releases the gate to new ingests behind a slow writer', async () => {
  const id = randomUUID();
  const org = `qa-export-boundary-${id}`;
  await prisma.organization.create({ data: { id: org, name: 'QA Export boundary', slug: org, createdAt: new Date() } });
  const project = await prisma.project.create({ data: { organizationId: org, name: 'QA Export slow writer', slug: 'slow-writer' } });
  const input = {
    id,
    userId: id,
    workspaceId: org,
    projectId: project.id,
    stream: `ws:${org}`,
    requested: { id: `${id}-requested`, action: 'export.requested' },
    unknown: { id: `${id}-outcome`, action: 'export.outcome_unknown' },
  };
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let writer: Promise<unknown> | undefined;
  try {
    const staged = await stageExport(input);
    writer = withProjectLock(
      project.id,
      async () => {
        entered();
        await waiting;
      },
      { mode: 'shared' },
    );
    await started;
    const timings: number[] = [];
    for (const work of [() => stageExport({ ...input, id: `${id}-other` }), () => validateExportMembership(project.id, staged.membership, id)]) {
      const start = performance.now();
      await expect(work()).rejects.toMatchObject({ code: 'export_project_busy', status: 503 });
      timings.push(performance.now() - start);
      expect(timings.at(-1)).toBeLessThan(3500);
    }
    // The slow ingest still owns its shared lock. A failed export must not keep its writer-preference gate.
    expect(await withProjectLock(project.id, async () => true, { mode: 'shared', waitMs: 100 })).toBe(true);
    console.log(
      JSON.stringify({
        event: 'qa.export_boundary',
        admissionMs: timings[0],
        finalizationMs: timings[1],
        contentionBudgetMs: 100,
        transactionDeadlineMs: 250,
        newSharedWriterProceeded: true,
      }),
    );
  } finally {
    release();
    await writer;
    await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
    await prisma.exportLease.deleteMany({ where: { projectId: project.id } });
    await prisma.organization.delete({ where: { id: org } });
  }
});
