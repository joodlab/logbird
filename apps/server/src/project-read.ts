import { prisma } from '@logbird/database';
import { ApiError } from './errors';
import { requireProjectReadable } from './ingest';

/** One statement gives a coherent generation/fence snapshot; no connection survives this call. */
async function readGeneration(projectId: string) {
  const [state] = await prisma.$queryRaw<{ generation: bigint; fenced: boolean }[]>`
    SELECT p."maintenanceGeneration" AS generation,
      EXISTS(SELECT 1 FROM "RetentionRun" r WHERE r."projectId"=p.id
        AND (r.status='running' OR (r.kind='ingest_repair' AND r.status='failed'))) AS fenced
    FROM "Project" p WHERE p.id=${projectId}`;
  if (!state) throw new ApiError(404, 'not_found', 'Project not found.');
  return state;
}
function unavailable() {
  return new ApiError(503, 'retention_unavailable', 'Project data is being rebuilt. Retry shortly.');
}
export async function beginRollupRead(projectId: string) {
  const state = await readGeneration(projectId);
  if (state.fenced) {
    // Preserve abandoned-run scheduling. This never holds a lock during the handler's ClickHouse I/O.
    await requireProjectReadable(projectId);
    throw unavailable();
  }
  return state.generation;
}
export async function finishRollupRead(projectId: string, generation: bigint) {
  const state = await readGeneration(projectId);
  if (state.fenced || state.generation !== generation) throw unavailable();
}
