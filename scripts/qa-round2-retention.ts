import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hasExpiredEvents, purgeProject } from '@trailmark/clickhouse';
import { closeProjectLocks, prisma } from '@trailmark/database';
import { requireProjectReadable } from '../apps/server/src/ingest';
import { generateApiKey } from '../apps/server/src/keys';
import { clickhouse, enforceProjectRetention } from '../apps/worker/src/retention';

const id = randomUUID();
const organization = await prisma.organization.create({ data: { id, name: 'Fictional retention availability', slug: id, createdAt: new Date() } });
const p = await prisma.project.create({ data: { organizationId: id, name: 'Availability probe', slug: id } });
const ingestKey = generateApiKey('ingest'),
  readKey = generateApiKey('read');
for (const [kind, key] of [
  ['ingest', ingestKey],
  ['read', readKey],
] as const)
  await prisma.apiKey.create({ data: { projectId: p.id, name: 'Fictional availability probe', kind, hash: key.hash, prefix: key.prefix } });
const statuses: number[] = [],
  latencies: number[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
const probes: Promise<void>[] = [];
try {
  const start = Date.now();
  await purgeProject(clickhouse, p.id); // old no-op path: raw delete plus all three aggregate deletes
  console.log(JSON.stringify({ baselineEmptyPurgeMs: Date.now() - start }));
  const projects = await prisma.project.findMany();
  const untouched: string[] = [];
  for (const project of projects)
    if (!(await hasExpiredEvents(clickhouse, project.id, new Date(Date.now() - project.retentionDays * 86_400_000)))) untouched.push(project.id);
  let readGuardChecks = 0;
  async function probe() {
    const start = Date.now();
    for (const [method, key, body] of [
      ['GET', readKey, undefined],
      ['POST', ingestKey, JSON.stringify({ action: 'availability.probe' })],
    ] as const) {
      const response = await fetch('http://127.0.0.1:4901/v1/events', {
        method,
        headers: { Authorization: `Bearer ${key.secret}`, 'Content-Type': 'application/json' },
        body,
      });
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    await Promise.all(
      untouched.map(async (projectId) => {
        await requireProjectReadable(projectId);
        readGuardChecks++;
      }),
    );
    await (
      await clickhouse.query({
        query: 'SELECT project_id,count() FROM events WHERE project_id IN {projects:Array(String)} GROUP BY project_id',
        query_params: { projects: untouched },
        format: 'JSONEachRow',
      })
    ).json();
    latencies.push(Date.now() - start);
  }
  timer = setInterval(() => probes.push(probe()), 250);
  const sweep = Date.now();
  for (const project of projects) await enforceProjectRetention(project.id);
  clearInterval(timer);
  timer = undefined;
  await Promise.all(probes);
  await probe();
  assert(statuses.every((status) => status === 200 || status === 202));
  console.log(
    JSON.stringify({
      projects: projects.length,
      untouchedProjects: untouched.length,
      sweepMs: Date.now() - sweep,
      probeRequests: statuses.length,
      readGuardChecks,
      unavailable: statuses.filter((s) => s === 503).length,
      maxReadIngestPairMs: Math.max(...latencies),
    }),
  );
} finally {
  if (timer) clearInterval(timer);
  await Promise.allSettled(probes);
  await purgeProject(clickhouse, p.id);
  await prisma.organization.delete({ where: { id: organization.id } });
  await Promise.all([clickhouse.close(), prisma.$disconnect(), closeProjectLocks()]);
}
