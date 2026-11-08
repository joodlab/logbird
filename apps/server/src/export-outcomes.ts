import { ASYNC_INSERT_FLUSH_BOUND_MS, INGEST_CLAIM_LEASE_MS } from '@logbird/clickhouse';
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
import { retryExportBoundary } from './export-lifecycle';

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
async function readMembership(db: Prisma.TransactionClient, projectId: string, receivedBefore: Date) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, exportDeleteStartedAt: true, exportGeneration: true, maintenanceGeneration: true },
  });
  const run = await db.retentionRun.findFirst({ where: { projectId }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] });
  if (!project || project.exportDeleteStartedAt || run?.status === 'running' || run?.status === 'failed')
    throw new ApiError(503, 'export_project_unreadable', 'Retention or deletion is incomplete for this project. Retry after maintenance finishes.');
  // An ambiguous INSERT can outlive its ingest caller's shared lock. Its first receipt clock is inside the fence,
  // so wait for confirmation/recovery rather than letting a queued pre-fence row appear behind the export cursor.
  const pending = await db.ingestReceipt.findFirst({
    where: {
      projectId,
      confirmedAt: null,
      claimedAt: { gte: new Date(+(await leaseClock(db)) - INGEST_CLAIM_LEASE_MS - ASYNC_INSERT_FLUSH_BOUND_MS) },
      receivedAt: { lte: receivedBefore },
    },
    select: { eventId: true },
  });
  if (pending) throw new ApiError(503, 'export_project_busy', 'Recent writes to this project are still settling. Retry the export.', undefined, 1);
  return `${project.exportGeneration}:${project.maintenanceGeneration}:${run?.id ?? ''}`;
}

export async function validateExportMembership(projectId: string, initial: string | null, id: string, signal = new AbortController().signal) {
  await retryExportBoundary(
    () =>
      exportBoundary(projectId, async (db) => {
        const lease = await db.exportLease.findUnique({ where: { id } });
        const now = await leaseClock(db);
        if (lease && lease.expiresAt <= now) throw new ApiError(503, 'export_lease_expired', 'The export expired. Retry the download.');
        if (!lease || lease.invalidated || (await readMembership(db, projectId, lease.receivedBefore)) !== initial) throw unavailable();
      }),
    signal,
  ).catch((error) => {
    if (error instanceof ApiError) {
      if (error.code === 'export_project_unreadable') throw unavailable();
      throw error;
    }
    if (signal.aborted) throw error;
    throw new ApiError(503, 'export_storage_unavailable', 'Export validation storage is unavailable. Retry the download.');
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
    signal?: AbortSignal;
  },
  at?: Date,
) {
  const namespace = auditNamespace();
  // Drain earlier writers, then register the fence before letting new writers enter.
  return retryExportBoundary(
    () =>
      exportBoundary(input.projectId, async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${namespace}:exports`},0))`;
        const now = await leaseClock(tx, at);
        let membership: string | null;
        try {
          membership = await readMembership(tx, input.projectId, input.receivedBefore ?? now);
        } catch (error) {
          if (!(error instanceof ApiError && error.code === 'export_project_unreadable')) throw error;
          membership = null;
        }
        const active = { namespace, expiresAt: { gt: now } };
        const [total, user, workspace] = await Promise.all([
          tx.exportLease.aggregate({ where: active, _sum: { weight: true } }),
          tx.exportLease.count({ where: { ...active, userId: input.userId } }),
          tx.exportLease.count({ where: { ...active, workspaceId: input.workspaceId } }),
        ]);
        const weight = input.sql ? 2 : 1;
        if (membership && ((total._sum.weight ?? 0) + weight > EXPORT_CONCURRENCY || user >= 1 || workspace >= 2))
          throw new ApiError(429, 'export_busy', 'An export is already running. Finish or cancel it, then retry.');
        const expiresAt = new Date(+now + EXPORT_LEASE_MS);
        if (membership)
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
        return { ...requested, membership, leaseMs: EXPORT_LEASE_MS };
      }),
    input.signal ?? new AbortController().signal,
  );
}

export async function renewExport(id: string, at?: Date) {
  return prisma.$transaction(async (tx) => {
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
    return EXPORT_LEASE_MS;
  });
}
export async function confirmExportOutcome(id: string, action: 'export.completed' | 'export.failed') {
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
  });
}
export async function releaseExportAdmission(id: string) {
  await prisma.exportLease.deleteMany({ where: { id, namespace: auditNamespace() } });
}
export async function releaseExport(id: string, action: 'export.completed' | 'export.failed') {
  await confirmExportOutcome(id, action);
  await releaseExportAdmission(id);
}

export async function getExportStatus(id: string, stream: string) {
  const row = await prisma.auditOutbox.findFirst({ where: { id: `${id}-outcome`, namespace: auditNamespace(), stream } });
  if (!row) throw new ApiError(404, 'not_found', 'Export record not found.');
  if (!row.confirmedAt) return { exportId: id, state: 'pending' as const, reason: null, description: null };
  const payload = row.payload as { action?: string; description?: string; metadata?: { export?: { reason?: string } } };
  const state = payload.action === 'export.completed' ? 'completed' : payload.action === 'export.failed' ? 'failed' : 'unknown';
  return { exportId: id, state, reason: payload.metadata?.export?.reason ?? null, description: payload.description ?? null };
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
