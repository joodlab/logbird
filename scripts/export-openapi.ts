import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { prisma } from '@logbird/database';
import { app } from '../apps/server/src/app';
import { clickhouse } from '../apps/server/src/clickhouse';
import { committedOpenApiDocument } from '../apps/server/src/openapi';
import { rateLimitStore } from '../apps/server/src/rate-limit';
import { closeRetentionQueue } from '../apps/worker/src/queue';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        // UTF-16 code-unit order: independent of the runtime's locale and collation data.
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
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
  // The served document names this instance's APP_URL; the committed files name the documented local default, so they
  // depend only on the code and CI checks them for drift (`pnpm openapi:check`).
  const committed = committedOpenApiDocument(spec);
  for (const [name, paths] of [
    ['openapi', spec.paths],
    ['public', Object.fromEntries(Object.entries(spec.paths).filter(([path]) => path.startsWith('/v1/')))],
  ] as const)
    await writeFile(`openapi/${name}.json`, `${JSON.stringify(stable({ ...committed, paths }), null, 2)}\n`);
  console.log(`Exported ${ids.size} operations in-process (no listening server).`);
  if (process.argv.includes('--check')) {
    // Any difference from the commit counts: a changed file, one the export recreated after it was deleted, a new export
    // nobody committed (untracked), and staged-only changes. Git errors throw and fail the check without this message.
    const changes = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', 'openapi'], { encoding: 'utf8' });
    if (changes) {
      console.log(changes);
      console.log(execFileSync('git', ['diff', '--', 'openapi'], { encoding: 'utf8' }));
      const message = 'The exported API differs from the committed openapi/ files. Run `pnpm openapi:export` and commit the result.';
      console.log(process.env.GITHUB_ACTIONS === 'true' ? `::error title=openapi/ is out of date::${message}` : message);
      process.exitCode = 1;
    }
  }
} finally {
  await rateLimitStore.quit();
  await closeRetentionQueue();
  await clickhouse.close();
  await prisma.$disconnect();
}
