// In-process, fictional fixtures only. No listeners/migrations. Run under the RAM guard:
// node --env-file=.env --import tsx scripts/benchmark-export-ingest.ts <output.json>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { purgeProject } from '@logbird/clickhouse';
import { auditNamespace, closeProjectLocks, prisma } from '@logbird/database';

const baselineRevision = '8ba30e0994f9489ea404c5a4c40a2e257483749e';
const baseline = execFileSync('git', ['show', `${baselineRevision}:apps/server/src/ingest.ts`], { encoding: 'utf8' });
const token = randomUUID();
process.env.BULLMQ_PREFIX = `{logbird-export-cost-${token}}`;
const namespace = auditNamespace();
const temporarySource = `apps/server/src/.benchmark-ingest-${token}.ts`;
const organizationId = `qa-export-cost-${token}`;
const batchCount = 200;
type Scenario = 'baseline_no_export' | 'after_no_export' | 'after_one_export';
const samples: Record<Scenario, { batchMs: number[]; lookupMs: number[]; lookupStatements: number }> = {
  baseline_no_export: { batchMs: [], lookupMs: [], lookupStatements: 0 },
  after_no_export: { batchMs: [], lookupMs: [], lookupStatements: 0 },
  after_one_export: { batchMs: [], lookupMs: [], lookupStatements: 0 },
};
let recording: Scenario | undefined;
let lookupTaken = false;
let projects: { id: string }[] = [];
let renewal: ReturnType<typeof setInterval> | undefined;
let renewalFailed = false;
let baselineWritten = false;
const raw = prisma.$queryRaw.bind(prisma);
const delegate = prisma.project;
const find = delegate.findUnique.bind(delegate);
const rawDescriptor = Object.getOwnPropertyDescriptor(prisma, '$queryRaw');
const findDescriptor = Object.getOwnPropertyDescriptor(delegate, 'findUnique');
const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    meanMs: values.reduce((a, b) => a + b, 0) / values.length,
    medianMs: sorted[Math.floor(values.length / 2)],
    p95Ms: sorted[Math.ceil(values.length * 0.95) - 1],
  };
};
const checksum = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const output: Record<string, unknown> = {
  baselineRevision,
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  ingestSourceSha256: checksum(await readFile('apps/server/src/ingest.ts')),
  databaseSourceSha256: checksum(await readFile('packages/database/src/index.ts')),
  baselineSourceSha256: checksum(baseline),
  batchesPerScenario: batchCount,
  eventsPerBatch: 1,
  method:
    '200 interleaved real ingest batches per scenario; same process/clients/shared services. Lookup timings are nested in full batch timings. Only the project lookup changed; fixed lock/retention/ClickHouse paths are shared.',
};
try {
  await writeFile(temporarySource, baseline, { flag: 'wx' });
  baselineWritten = true;
  const before = (await import(pathToFileURL(`${process.cwd()}/${temporarySource}`).href)).ingest;
  const { ingest: after } = await import('../apps/server/src/ingest');
  const { stageExport, renewExport, releaseExport } = await import('../apps/server/src/export-outcomes');
  await prisma.organization.create({ data: { id: organizationId, name: 'QA Export ingest timing', slug: organizationId, createdAt: new Date() } });
  projects = await prisma.project.createManyAndReturn({
    data: [0, 1, 2].map((index) => ({ organizationId, name: `QA Export timing ${index}`, slug: `timing-${index}` })),
  });
  const active = projects[2];
  assert.ok(active);
  await stageExport({
    id: token,
    userId: token,
    workspaceId: organizationId,
    projectId: active.id,
    stream: `ws:${organizationId}`,
    receivedBefore: new Date(Date.now() - 60_000),
    requested: { id: `${token}-requested`, action: 'export.requested' },
    unknown: { id: `${token}-outcome`, action: 'export.outcome_unknown' },
  });
  renewal = setInterval(() => {
    void renewExport(token).catch(() => {
      renewalFailed = true;
    });
  }, 10_000);
  const cases = Object.keys(samples) as Scenario[];
  async function batch(scenario: Scenario, measure: boolean) {
    const index = cases.indexOf(scenario);
    const project = projects[index];
    assert.ok(project);
    recording = measure ? scenario : undefined;
    lookupTaken = false;
    const start = performance.now();
    const result = await (index === 0 ? before : after)(project.id, { id: randomUUID(), action: 'qa.export.ingest_timing', metadata: { scenario } });
    if (measure) samples[scenario].batchMs.push(performance.now() - start);
    recording = undefined;
    assert.equal(result.accepted, 1);
    assert.equal(result.rejected.length, 0);
  }
  Object.defineProperty(prisma, '$queryRaw', {
    configurable: true,
    value: async (...args: unknown[]) => {
      const capture = recording && !lookupTaken && String(args[0]).includes('WITH current_project') ? recording : undefined;
      if (capture) lookupTaken = true;
      const start = performance.now();
      const result = await Reflect.apply(raw, prisma, args);
      if (capture) {
        samples[capture].lookupMs.push(performance.now() - start);
        samples[capture].lookupStatements++;
      }
      return result;
    },
  });
  Object.defineProperty(delegate, 'findUnique', {
    configurable: true,
    value: async (...args: unknown[]) => {
      const capture = recording === 'baseline_no_export' && !lookupTaken ? recording : undefined;
      if (capture) lookupTaken = true;
      const start = performance.now();
      const result = await Reflect.apply(find, delegate, args);
      if (capture) {
        samples[capture].lookupMs.push(performance.now() - start);
        samples[capture].lookupStatements++;
      }
      return result;
    },
  });
  for (let warmup = 0; warmup < 10; warmup++) for (const scenario of cases) await batch(scenario, false);
  for (let index = 0; index < batchCount; index++)
    for (let offset = 0; offset < cases.length; offset++) {
      const scenario = cases[(index + offset) % cases.length];
      assert.ok(scenario);
      await batch(scenario, true);
    }
  assert.equal(renewalFailed, false);
  assert.equal((await prisma.exportLease.findUniqueOrThrow({ where: { id: token } })).invalidated, false);
  for (const sample of Object.values(samples)) {
    assert.equal(sample.batchMs.length, batchCount);
    assert.equal(sample.lookupStatements, batchCount);
  }
  output.results = Object.fromEntries(
    cases.map((name) => [
      name,
      {
        batch: summarize(samples[name].batchMs),
        projectLookup: summarize(samples[name].lookupMs),
        lookupStatementsPerBatch: samples[name].lookupStatements / batchCount,
      },
    ]),
  );
  output.rawSamples = samples;
  await releaseExport(token, 'export.failed');
} finally {
  recording = undefined;
  clearInterval(renewal);
  if (rawDescriptor) Object.defineProperty(prisma, '$queryRaw', rawDescriptor);
  else delete (prisma as unknown as Record<string, unknown>).$queryRaw;
  if (findDescriptor) Object.defineProperty(delegate, 'findUnique', findDescriptor);
  else delete (delegate as unknown as Record<string, unknown>).findUnique;
  const { clickhouse, queryClickhouse } = await import('../apps/server/src/clickhouse');
  const { rateLimitStore } = await import('../apps/server/src/rate-limit');
  const { retentionQueue, connection, closeRetentionQueue } = await import('../apps/worker/src/queue');
  try {
    for (const project of projects) {
      await purgeProject(clickhouse, project.id);
      await prisma.$executeRaw`DELETE FROM "IngestReceipt" WHERE "projectId"=${project.id}`;
    }
    await prisma.auditOutbox.deleteMany({ where: { namespace } });
    await prisma.exportLease.deleteMany({ where: { namespace } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await retentionQueue.obliterate({ force: true });
    const keys = await connection.keys(`${namespace}:*`);
    if (keys.length) await connection.unlink(...keys);
    output.cleanup = {
      postgresProjects: await prisma.project.count({ where: { id: { in: projects.map((p) => p.id) } } }),
      outbox: await prisma.auditOutbox.count({ where: { namespace } }),
      leases: await prisma.exportLease.count({ where: { namespace } }),
      redisKeys: (await connection.keys(`${namespace}:*`)).length,
    };
  } finally {
    if (baselineWritten) {
      assert.equal(checksum(await readFile(temporarySource)), checksum(baseline));
      await unlink(temporarySource);
    }
    await closeRetentionQueue();
    await rateLimitStore.quit();
    await clickhouse.close();
    await queryClickhouse?.close();
    await closeProjectLocks();
    await prisma.$disconnect();
    await writeFile(process.argv[2] ?? 'export-ingest-benchmark.json', `${JSON.stringify(output, null, 2)}\n`);
  }
}
console.log(JSON.stringify({ results: output.results, cleanup: output.cleanup }));
