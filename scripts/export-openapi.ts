import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { prisma } from '@logbird/database';
import { app } from '../apps/server/src/app';
import { clickhouse } from '../apps/server/src/clickhouse';
import { rateLimitStore } from '../apps/server/src/rate-limit';
import { closeRetentionQueue } from '../apps/worker/src/queue';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

try {
  const response = await app.request('/openapi.json');
  assert.equal(response.status, 200);
  const spec = await response.json();
  const ids = new Set<string>();
  for (const item of Object.values(spec.paths) as Record<
    string,
    { operationId: string; summary: string; tags: string[]; responses: object; security: object[] }
  >[]) {
    for (const [method, operation] of Object.entries(item)) {
      if (!['get', 'post', 'patch', 'delete', 'put'].includes(method)) continue;
      assert.ok(operation.operationId && operation.summary && operation.tags?.length && operation.responses && operation.security);
      assert.ok(!ids.has(operation.operationId), `Duplicate operationId: ${operation.operationId}`);
      ids.add(operation.operationId);
    }
  }
  await mkdir('openapi', { recursive: true });
  for (const [name, paths] of [
    ['openapi', spec.paths],
    ['public', Object.fromEntries(Object.entries(spec.paths).filter(([path]) => path.startsWith('/v1/')))],
  ] as const)
    await writeFile(`openapi/${name}.json`, `${JSON.stringify(stable({ ...spec, paths }), null, 2)}\n`);
  console.log(`Exported ${ids.size} operations in-process (no listening server).`);
} finally {
  await rateLimitStore.quit();
  await closeRetentionQueue();
  await clickhouse.close();
  await prisma.$disconnect();
}
