import { prisma } from './index';

/** Expire confirmed claims only. An unresolved INSERT must never become writable by timeout. */
export const INGEST_RECEIPT_WINDOW_MS = 10 * 60_000;
export async function pruneIngestReceipts(projectId?: string) {
  await prisma.ingestReceipt.deleteMany({ where: { projectId, confirmedAt: { lt: new Date(Date.now() - INGEST_RECEIPT_WINDOW_MS) } } });
}

/** Call after the matching ClickHouse purge while holding the exclusive project lock. */
export async function purgeIngestReceipts(projectId: string, cutoff?: Date) {
  await prisma.ingestReceipt.deleteMany({ where: { projectId, ...(cutoff ? { eventAt: { lt: cutoff } } : {}) } });
}
