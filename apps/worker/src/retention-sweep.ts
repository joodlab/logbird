import { projectMaintenance } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { logIngestRecoveryFailure, recoverProjectIngest } from './ingest-recovery';
import { clickhouse, enforceProjectRetention, pruneReceiptBackstop } from './retention';

export async function enforceRetention() {
  await pruneReceiptBackstop(); // Includes idle workspace audit streams.
  const failures: unknown[] = [];
  try {
    const pendingProjects = await prisma.ingestReceipt.findMany({
      where: { confirmedAt: null },
      distinct: ['projectId'],
      select: { projectId: true },
    });
    for (const pending of pendingProjects) {
      try {
        await recoverProjectIngest(projectMaintenance(clickhouse, pending.projectId), pending.projectId);
      } catch (error) {
        logIngestRecoveryFailure(error, pending.projectId);
        failures.push(error);
      }
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    console.error(JSON.stringify({ level: 'error', event: 'ingest.pending_projects_failed', code }));
    failures.push(error);
  }
  try {
    const projects = await prisma.project.findMany({ select: { id: true } });
    for (const project of projects) {
      try {
        await enforceProjectRetention(project.id);
      } catch (error) {
        failures.push(error);
      }
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    console.error(JSON.stringify({ level: 'error', event: 'retention.projects_failed', code }));
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, 'Retention sweep failed for some projects');
}
