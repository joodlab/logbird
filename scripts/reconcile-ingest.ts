import { existingEventIdentities } from '@logbird/clickhouse';
import { closeProjectLocks, prisma, withProjectLock } from '@logbird/database';
import { clickhouse } from '../apps/server/src/clickhouse';

// Run with all API/worker writers stopped and ClickHouse's async insert queue drained.
// The flag is an operator attestation, not a distributed fencing mechanism.
const projectId = process.argv[2];
const releaseMissing = process.argv.includes('--release-missing-writers-stopped');
if (!projectId) throw new Error('Usage: node --env-file=.env --import tsx scripts/reconcile-ingest.ts PROJECT [--release-missing-writers-stopped]');
try {
  await withProjectLock(projectId, async () => {
    let confirmed = 0,
      missing = 0,
      conflicts = 0;
    let after: string | undefined;
    while (true) {
      const receipts = await prisma.ingestReceipt.findMany({
        where: { projectId, confirmedAt: null, ...(after ? { eventId: { gt: after } } : {}) },
        orderBy: { eventId: 'asc' },
        take: 1000,
      });
      if (!receipts.length) break;
      const stored = await existingEventIdentities(
        clickhouse,
        projectId,
        receipts.map((r) => r.eventId),
      );
      for (const receipt of receipts) {
        const where = { projectId_eventId: { projectId, eventId: receipt.eventId } };
        const existing = stored.get(receipt.eventId);
        if (existing?.fingerprint === receipt.fingerprint) {
          await prisma.ingestReceipt.update({ where, data: { confirmedAt: new Date() } });
          confirmed++;
        } else if (!existing) {
          missing++;
          if (releaseMissing) await prisma.ingestReceipt.delete({ where });
        } else conflicts++;
      }
      after = receipts.at(-1)?.eventId;
    }
    console.log(JSON.stringify({ confirmed, missing, conflicts, releasedMissing: releaseMissing ? missing : 0 }));
  });
} finally {
  await clickhouse.close();
  await closeProjectLocks();
  await prisma.$disconnect();
}
