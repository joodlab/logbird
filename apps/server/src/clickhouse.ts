import {
  ASYNC_INSERT_FLUSH_BOUND_MS,
  createClickHouseClient,
  createMaintenanceClickHouseClient,
  createQueryClickHouseClient,
  INGEST_CLAIM_LEASE_MS,
  projectMaintenance,
  purgeProject,
  stopProjectMaintenance,
} from '@logbird/clickhouse';
import { prisma, purgeIngestReceipts } from '@logbird/database';
import { ApiError } from './errors';
import { projectHasNoStoredRows, projectPurger, settleInFlightInserts } from './project-emptiness';
export const clickhouse = createClickHouseClient();
export const maintenanceClickhouse = createMaintenanceClickHouseClient();

/** Newest receipt whose insert may still be in flight: claimed, never confirmed. */
const newestUnresolvedClaim = async (projectId: string) =>
  (
    await prisma.ingestReceipt.findFirst({
      where: { projectId, confirmedAt: null, claimedAt: { not: null } },
      orderBy: { claimedAt: 'desc' },
      select: { claimedAt: true },
    })
  )?.claimedAt ?? null;

/**
 * Run first under the exclusive project lock when deleting a project: stops every tagged maintenance statement of the
 * project that ClickHouse is still executing (a rollup rebuild or index repair whose call failed keeps running
 * server-side and could commit after the purge). 503 `maintenance_pending` (retryable) when one cannot be confirmed
 * stopped; nothing is deleted then.
 */
export async function stopMaintenance(projectId: string) {
  try {
    return await stopProjectMaintenance(maintenanceClickhouse, projectId);
  } catch {
    throw new ApiError(
      503,
      'maintenance_pending',
      'A maintenance job for this project is still stopping. Try deleting it again shortly.',
      undefined,
      10,
    );
  }
}

/**
 * Run under the exclusive project lock before `purgeProjectEvents` when deleting a project: proves no claimed insert
 * for it can still land in ClickHouse (503 `ingest_pending` with Retry-After while a claim is inside its lease + flush
 * bound; afterwards a `SYSTEM FLUSH ASYNC INSERT QUEUE` settles it). See `settleInFlightInserts`.
 */
export const settleProjectInserts = (projectId: string) =>
  settleInFlightInserts({
    newestUnresolvedClaim: () => newestUnresolvedClaim(projectId),
    flush: () => maintenanceClickhouse.command({ query: 'SYSTEM FLUSH ASYNC INSERT QUEUE', clickhouse_settings: { max_execution_time: 30 } }),
    leaseMs: INGEST_CLAIM_LEASE_MS,
    flushBoundMs: ASYNC_INSERT_FLUSH_BOUND_MS,
  });

/**
 * Purges everything a project stored. Callers hold the exclusive project lock. The ClickHouse mutations are skipped
 * only when no insert of the project's own can still be queued — the caller ran `settleProjectInserts` under the same
 * lock (`{ settled: true }`), or no unresolved ingest claim exists — and no project-scoped ClickHouse table (including
 * event ids) holds a row for it. Cleanup outside ClickHouse belongs in `alwaysRun`, so it also
 * runs on that fast path: ingest receipts live in PostgreSQL and must never outlive their project.
 */
export const purgeProjectEvents = projectPurger({
  hasNoStoredRows: async (projectId, settled) =>
    (settled || (await newestUnresolvedClaim(projectId)) === null) && (await projectHasNoStoredRows(maintenanceClickhouse, projectId)),
  purgeClickhouse: (projectId) => purgeProject(projectMaintenance(maintenanceClickhouse, projectId), projectId),
  alwaysRun: [purgeIngestReceipts],
});
export const queryClickhouse = createQueryClickHouseClient();
/** Server-generated query id only; never a user-supplied KILL predicate. */
export async function cancelExportQuery(queryId: string) {
  try {
    const result = await clickhouse.query({
      query: 'KILL QUERY WHERE query_id={queryId:String} SYNC',
      query_params: { queryId },
      format: 'JSONEachRow',
    });
    await result.json();
  } catch (error) {
    if (!(error && typeof error === 'object' && 'type' in error && error.type === 'NOTHING_TO_KILL')) throw error;
  }
}
