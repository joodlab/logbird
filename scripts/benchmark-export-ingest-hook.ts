/** PG-only A/B cost of the two existing ingest statements; no ClickHouse writes, no services started.
 * Run: node --env-file=.env --import tsx scripts/benchmark-export-ingest-hook.ts <output.json>
 * Baseline SQL is frozen from merged #62 d829ab1. Each fictional 1000-row batch rolls back.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { claimIngestReceipts, findIngestProject, Prisma, prisma } from '@logbird/database';

const org = `qa-export-cost-${randomUUID()}`,
  project = `qa-export-cost-${randomUUID()}`;
const batches = 200,
  size = 1000;
const rollback = new Error('QA benchmark rollback');
const results: { activeExport: boolean; variant: string; batches: number; size: number; medianMs: number; p95Ms: number; meanMs: number }[] = [];
async function baselineClaim(db: Prisma.TransactionClient, claims: Parameters<typeof claimIngestReceipts>[2]) {
  return db.$queryRaw(Prisma.sql`
    INSERT INTO "IngestReceipt" ("projectId","organizationId","eventId","fingerprint","receivedAt","eventAt","confirmedAt","claimedAt")
    SELECT ${project},${org},v.id,v.fingerprint,v.received,v.event,v.confirmed,v.claimed
    FROM unnest(${claims.map((r) => r.eventId)}::text[],${claims.map((r) => r.fingerprint)}::text[],
      ${claims.map((r) => r.receivedAt.toISOString())}::timestamp[],${claims.map((r) => r.eventAt.toISOString())}::timestamp[],
      ${claims.map((r) => r.confirmedAt?.toISOString() ?? null)}::timestamp[],${claims.map((r) => r.claimedAt.toISOString())}::timestamp[])
      AS v(id,fingerprint,received,event,confirmed,claimed)
    ORDER BY v.id ON CONFLICT ("projectId","eventId") DO NOTHING RETURNING *`);
}
try {
  await prisma.organization.create({ data: { id: org, name: 'QA Export hook cost', slug: org, createdAt: new Date() } });
  await prisma.project.create({ data: { id: project, organizationId: org, name: 'QA Export hook cost', slug: project } });
  for (const activeExport of [false, true]) {
    if (activeExport)
      await prisma.exportLease.create({
        data: {
          id: randomUUID(),
          namespace: org,
          userId: org,
          workspaceId: org,
          projectId: project,
          weight: 1,
          receivedBefore: new Date(),
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
    const measurements = { baseline: [] as number[], fenced: [] as number[] };
    // Interleave variants, reverse their order every batch to reduce clock/load bias.
    for (let batch = 0; batch < batches; batch++)
      for (const variant of batch % 2 ? (['fenced', 'baseline'] as const) : (['baseline', 'fenced'] as const)) {
        try {
          await prisma.$transaction(async (db) => {
            const initial = new Date();
            const claims = Array.from({ length: size }, (_, i) => ({
              eventId: `${batch}-${i}`,
              fingerprint: 'v1:qa-cost',
              receivedAt: initial,
              eventAt: initial,
              confirmedAt: null,
              claimedAt: initial,
            }));
            const started = performance.now();
            if (variant === 'baseline') {
              await db.project.findUnique({ where: { id: project } });
              await baselineClaim(db, claims);
            } else {
              const p = await findIngestProject(db, project);
              if (!p) throw new Error('QA project missing');
              for (const row of claims) {
                row.receivedAt = p.acceptedAt;
                row.eventAt = p.acceptedAt;
              }
              await claimIngestReceipts(project, org, claims, db);
            }
            measurements[variant].push(performance.now() - started);
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
      }
    for (const [variant, times] of Object.entries(measurements)) {
      times.sort((a, b) => a - b);
      results.push({
        activeExport,
        variant,
        batches,
        size,
        medianMs: times[Math.floor(times.length / 2)]!,
        p95Ms: times[Math.floor(times.length * 0.95)]!,
        meanMs: times.reduce((a, b) => a + b, 0) / times.length,
      });
    }
  }
  const proof = {
    scope: 'PG lookup + receipt-claim statements only; transaction setup/rollback and unchanged CH INSERT excluded; no extra round trips',
    baseline: 'd829ab1',
    results,
  };
  console.log(JSON.stringify(proof));
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(proof, null, 2));
} finally {
  await prisma.exportLease.deleteMany({ where: { projectId: project } });
  await prisma.ingestReceipt.deleteMany({ where: { projectId: project } });
  await prisma.organization.deleteMany({ where: { id: org } });
  await prisma.$disconnect();
}
