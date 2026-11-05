import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClickHouseClient, listEntities, purgeProject } from '@trailmark/clickhouse';
import { prisma } from '@trailmark/database';
import { Trailmark } from '@trailmark/sdk';
import { generateApiKey } from '../apps/server/src/keys';

const id = randomUUID(),
  ch = createClickHouseClient();
await prisma.organization.create({ data: { id, name: 'Fictional example proof', slug: id, createdAt: new Date() } });
const project = await prisma.project.create({ data: { organizationId: id, name: 'Example proof', slug: id } });
const key = generateApiKey('ingest');
await prisma.apiKey.create({ data: { projectId: project.id, name: 'Fictional example', kind: 'ingest', hash: key.hash, prefix: key.prefix } });
const child = spawn(process.execPath, ['--import', 'tsx', 'examples/hono/index.ts'], {
  env: { ...process.env, PORT: '4902', TRAILMARK_ENDPOINT: 'http://127.0.0.1:4901', TRAILMARK_INGEST_KEY: key.secret },
  stdio: 'ignore',
  windowsHide: true,
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const r = await fetch('http://127.0.0.1:4902/demo', { method: 'POST' });
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // The child may still be starting.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(ready, 'Hono example must start');
  let executor = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await listEntities(ch, project.id, { kind: 'executor', limit: 25 });
    if (result.data.some((e) => e.id === 'demo-api' && e.name === 'Demo API')) {
      executor = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(executor, 'Executors lists Demo API');
  const drops: string[] = [],
    errors: string[] = [];
  const sdk = new Trailmark({
    apiKey: key.secret,
    endpoint: 'http://127.0.0.1:4901',
    onDrop: (e) => drops.push(e.action),
    onError: (error) => errors.push(error.message),
  });
  sdk.track({ action: 'poison', occurredAt: Date.now() * 1000 });
  sdk.track({ action: 'good' });
  await sdk.flush();
  sdk.track({ action: 'later' });
  await sdk.shutdown();
  assert.deepEqual(drops, ['poison']);
  assert.equal(errors.length, 1);
  assert.equal(sdk.queueSize, 0);
  const rows = await (
    await ch.query({ query: 'SELECT action FROM events WHERE project_id={p:String}', query_params: { p: project.id }, format: 'JSONEachRow' })
  ).json<{ action: string }>();
  assert(rows.some((e) => e.action === 'good'));
  assert(rows.some((e) => e.action === 'later'));
  assert(!rows.some((e) => e.action === 'poison'));
  console.log('R2-10 Hono POST /demo -> Executors Demo API; R2-1 real SDK poison dropped, good and later stored, queue=0');
} finally {
  child.kill();
  await purgeProject(ch, project.id);
  await prisma.organization.delete({ where: { id } });
  await Promise.all([ch.close(), prisma.$disconnect()]);
}
