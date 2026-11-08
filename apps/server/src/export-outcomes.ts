import {
  type AuditPayload,
  auditNamespace,
  freezeAuditEvent,
  Prisma,
  ProjectBusyError,
  prisma,
  storeAuditEvent,
  withProjectLock,
} from '@logbird/database';
import { ApiError } from './errors';

export const EXPORT_LEASE_MS = 60_000;
export const EXPORT_CONCURRENCY = 2;
export const EXPORT_BOUNDARY_WAIT_MS = 100;
export const EXPORT_BOUNDARY_TX_MS = 250;
const unavailable = () => new ApiError(503, 'export_invalidated', 'Stored events changed during the export. Retry and use the new file.');
async function exportBoundary<T>(projectId: string, work: (db: Prisma.TransactionClient) => Promise<T>) {
  try {
    return await withProjectLock(
      projectId,
      () =>
        prisma.$transaction(
          async (db) => {
            await db.$queryRaw`SELECT set_config('lock_timeout','100ms',true) AS lock_timeout, set_config('statement_timeout','100ms',true) AS statement_timeout`;
            return work(db);
          },
          { maxWait: 50, timeout: EXPORT_BOUNDARY_TX_MS },
        ),
      { waitMs: EXPORT_BOUNDARY_WAIT_MS },
    );
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const meta =
      error && typeof error === 'object' && 'meta' in error
        ? (error.meta as { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } })
        : undefined;
    const pgCode = meta?.code ?? meta?.driverAdapterError?.cause?.originalCode ?? '';
    if (error instanceof ProjectBusyError || code === 'P2028' || ['55P03', '57014'].includes(pgCode))
      throw new ApiError(503, 'export_project_busy', 'The project is processing writes or maintenance. Retry the export.');
    throw error;
  }
}
async function leaseClock(tx: Prisma.TransactionClient, override?: Date) {
  return override ?? (await tx.$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() now`)[0].now;
}

/** Caller holds the exclusive project boundary lock; never hold it over a download. */
async function readMembership(db: Prisma.TransactionClient, projectId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, exportDeleteStartedAt: true, exportGeneration: true },
  });
  const run = await db.retentionRun.findFirst({ where: { projectId }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] });
  if (!project || project.exportDeleteStartedAt || run?.status === 'running' || run?.status === 'failed') throw unavailable();
  return `${project.exportGeneration}:${run?.id ?? ''}`;
}

export async function validateExportMembership(projectId: string, initial: string | null, id: string) {
  await exportBoundary(projectId, async (db) => {
    const lease = await db.exportLease.findUnique({ where: { id } });
    if (!lease || lease.invalidated || (await readMembership(db, projectId)) !== initial) throw unavailable();
  }).catch((error) => {
    if (error instanceof ApiError && error.code === 'export_project_busy') throw error;
    throw unavailable();
  });
}

/** Requested evidence, unknown-outcome fallback and cross-replica admission commit together. */
export async function stageExport(
  input: {
    id: string;
    userId: string;
    workspaceId: string;
    projectId: string;
    stream: string;
    requested: AuditPayload;
    unknown: AuditPayload;
    sql?: boolean;
    receivedBefore?: Date;
  },
  at?: Date,
) {
  const namespace = auditNamespace();
  // Drain earlier writers, then register the fence before letting new writers enter.
  return exportBoundary(input.projectId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${namespace}:exports`},0))`;
    const now = await leaseClock(tx, at);
    const membership = await readMembership(tx, input.projectId);
    const active = { namespace, expiresAt: { gt: now } };
    const [total, user, workspace] = await Promise.all([
      tx.exportLease.aggregate({ where: active, _sum: { weight: true } }),
      tx.exportLease.count({ where: { ...active, userId: input.userId } }),
      tx.exportLease.count({ where: { ...active, workspaceId: input.workspaceId } }),
    ]);
    const weight = input.sql ? 2 : 1;
    if ((total._sum.weight ?? 0) + weight > EXPORT_CONCURRENCY || user >= 1 || workspace >= 2)
      throw new ApiError(429, 'export_busy', 'An export is already running. Finish or cancel it, then retry.');
    const expiresAt = new Date(+now + EXPORT_LEASE_MS);
    await tx.exportLease.create({
      data: {
        id: input.id,
        namespace,
        userId: input.userId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        expiresAt,
        weight,
        receivedBefore: input.receivedBefore ?? now,
      },
    });
    const requested = await storeAuditEvent(input.stream, input.requested, tx);
    await tx.auditOutbox.create({
      data: { ...freezeAuditEvent(input.unknown), stream: input.stream, namespace, confirmedAt: null, awaitingUntil: expiresAt },
    });
    return { ...requested, membership };
  });
}

export async function renewExport(id: string, at?: Date) {
  await prisma.$transaction(async (tx) => {
    const now = await leaseClock(tx, at);
    const expiresAt = new Date(+now + EXPORT_LEASE_MS);
    // Same lock order as settlement/reaping: outcome, then admission lease.
    await tx.$queryRaw`SELECT id FROM "AuditOutbox" WHERE id=${`${id}-outcome`} AND namespace=${auditNamespace()} FOR UPDATE`;
    // An expired lease cannot be resurrected while a replacement export owns the capacity.
    const lease = await tx.exportLease.updateMany({ where: { id, namespace: auditNamespace(), expiresAt: { gt: now } }, data: { expiresAt } });
    if (!lease.count) throw new ApiError(503, 'export_lease_expired', 'The export expired. Retry the download.');
    await tx.auditOutbox.updateMany({
      where: { id: `${id}-outcome`, namespace: auditNamespace(), confirmedAt: null },
      data: { awaitingUntil: expiresAt },
    });
  });
}
export async function releaseExport(id: string, action: 'export.completed' | 'export.failed') {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ pendingOutcome: AuditPayload | null }[]>`SELECT "pendingOutcome" FROM "AuditOutbox"
      WHERE id=${`${id}-outcome`} AND namespace=${auditNamespace()} AND "confirmedAt" IS NULL FOR UPDATE`;
    if (rows[0]) {
      // A failed cancellation UPDATE must never accidentally confirm the earlier completion draft.
      const pending = rows[0].pendingOutcome;
      await tx.auditOutbox.update({
        where: { id: `${id}-outcome` },
        data: {
          ...(pending?.action === action ? { payload: pending } : {}),
          confirmedAt: new Date(),
          awaitingUntil: null,
          pendingOutcome: Prisma.DbNull,
        },
      });
    }
    await tx.exportLease.deleteMany({ where: { id, namespace: auditNamespace() } });
  });
}

/** The frozen event is retried exactly; a failed UPDATE always leaves the durable unknown fallback. */
export async function finishExport(id: string, stream: string, event: AuditPayload) {
  const frozen = freezeAuditEvent({ ...event, id: `${id}-outcome` });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          { confirmedAt: Date | null; payload: Prisma.JsonValue }[]
        >`SELECT "confirmedAt",payload FROM "AuditOutbox" WHERE id=${frozen.id} AND namespace=${auditNamespace()} FOR UPDATE`;
        const row = rows[0];
        if (!row) return; // Staging itself failed closed; no bytes left.
        if (!row.confirmedAt) {
          await tx.auditOutbox.update({ where: { id: frozen.id }, data: { pendingOutcome: frozen.payload } });
        } else if (JSON.stringify(row.payload) !== JSON.stringify(frozen.payload)) {
          // Cancellation after a committed completion, or recovery after outcome_unknown, is a new immutable correction.
          const correction = freezeAuditEvent({ ...event, id: `${id}-${event.action.split('.')[1]}` });
          await tx.auditOutbox.upsert({ where: { id: correction.id }, create: { ...correction, stream, namespace: auditNamespace() }, update: {} });
        }
      });
      return;
    } catch {
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
  console.error(JSON.stringify({ event: 'export.audit_storage_unavailable', exportId: id, action: event.action }));
}

/** Every replica reclaims abandoned outcomes; SKIP LOCKED and the row lock fence late producers. */
export async function sweepExportOutcomes(at?: Date) {
  await prisma.$transaction(async (tx) => {
    const now = await leaseClock(tx, at);
    await tx.$executeRaw`UPDATE "AuditOutbox" SET "confirmedAt"=${now}, "awaitingUntil"=NULL, "pendingOutcome"=NULL WHERE id IN (
      SELECT id FROM "AuditOutbox" WHERE namespace=${auditNamespace()} AND "confirmedAt" IS NULL AND "awaitingUntil"<=${now}
      ORDER BY "awaitingUntil" LIMIT 100 FOR UPDATE SKIP LOCKED)`;
    await tx.$executeRaw`DELETE FROM "ExportLease" WHERE id IN (SELECT id FROM "ExportLease" WHERE namespace=${auditNamespace()} AND "expiresAt"<=${now} ORDER BY "expiresAt" LIMIT 100 FOR UPDATE SKIP LOCKED)`;
  });
}
