import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClickHouseClient, purgeProject } from '@logbird/clickhouse';
import { prisma, withProjectLock } from '@logbird/database';
import { readAuditTrail } from '@logbird/sdk/read';
import { generateApiKey } from '../apps/server/src/keys';

const root = process.cwd();
const endpoint = 'http://127.0.0.1:4871';
const children = new Set<ChildProcess>();
function launch(name: string, cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const log = createWriteStream(resolve(root, `.tmp/${name}.log`));
  const child = spawn(process.execPath, args, {
    cwd: resolve(root, cwd),
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.add(child);
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.pid)
    await new Promise<void>((done) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', () => done());
    });
  children.delete(child);
}
async function ready(url: string, child: ChildProcess) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error('Example exited before ready; inspect private .tmp log');
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  throw new Error('Example startup deadline exceeded; inspect private .tmp log');
}
const ch = createClickHouseClient();
let orgId: string | undefined;
let projectId: string | undefined;
try {
  for (const port of [4872, 4871]) {
    let occupied = false;
    try {
      await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) });
      occupied = true;
    } catch {
      /* expected free port */
    }
    assert.equal(occupied, false, `Port ${port} must be free`);
  }
  const id = crypto.randomUUID();
  const org = await prisma.organization.create({
    data: { id, name: 'Integration smoke fictional', slug: `integration-${id}`, createdAt: new Date() },
  });
  orgId = org.id;
  const project = await prisma.project.create({ data: { name: 'Integration smoke fictional', slug: 'integration-smoke', organizationId: org.id } });
  projectId = project.id;
  const ingest = generateApiKey('ingest');
  const read = generateApiKey('read');
  for (const [kind, key] of [
    ['ingest', ingest],
    ['read', read],
  ] as const)
    await prisma.apiKey.create({ data: { projectId, name: 'Disposable integration verification', kind, hash: key.hash, prefix: key.prefix } });
  const server = launch('integration-server', '.', ['--env-file=.env', '--import', 'tsx', 'apps/server/src/index.ts'], {
    PORT: '4871',
    APP_URL: endpoint,
  });
  await ready(`${endpoint}/health`, server);
  const env = {
    PORT: '4872',
    NITRO_PORT: '4872',
    LOGBIRD_ENDPOINT: endpoint,
    LOGBIRD_INGEST_KEY: ingest.secret,
    LOGBIRD_READ_KEY: read.secret,
  };
  const results: object[] = [];
  const specification = await (await fetch(`${endpoint}/openapi.json`)).json();
  assert.equal(specification.servers[0].url, endpoint);
  const ingestExample = specification.paths['/v1/events'].post.requestBody.content['application/json'].example;
  const exampleResponse = await fetch(`${specification.servers[0].url}/v1/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ingest.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(ingestExample),
  });
  assert.equal(exampleResponse.status, 202);
  const readExample = specification.paths['/v1/events'].get.parameters.find((parameter: { name: string }) => parameter.name === 'q').schema.example;
  assert.equal((await readAuditTrail({ endpoint, readKey: read.secret }, { q: readExample })).data[0]?.action, 'document.updated');
  console.log('openapi: advertised instance URL and ingest/read request examples passed real HTTP (202/200)');

  for (const name of ['hono', 'vue', 'tanstack-start', 'nuxt']) {
    const args =
      name === 'nuxt'
        ? [resolve(root, 'node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--port', '4872', '--host', '127.0.0.1']
        : name === 'tanstack-start'
          ? [resolve(root, 'node_modules/vite/bin/vite.js'), '--port', '4872', '--host', '127.0.0.1', '--strictPort']
          : ['--import', 'tsx', 'index.ts'];
    const child = launch(`example-${name}`, `examples/${name}`, args, env);
    try {
      await ready('http://127.0.0.1:4872/', child);
      const operation = `smoke-${name}-${id}`;
      const response = await fetch(`http://127.0.0.1:4872/${name === 'nuxt' ? 'api/' : ''}demo`, {
        method: 'POST',
        headers: { 'x-logbird-operation': operation },
      });
      assert.equal(response.status, 200, `${name} mutation status`);
      let found = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const page = await readAuditTrail({ endpoint, readKey: read.secret }, { q: `operation:"${operation}"` });
        const event = page.data.find((event) => event.action === `${name}.record.updated`);
        if (event) {
          assert.equal(event.actor?.id, 'demo-user');
          assert.equal(event.tenant?.id, 'demo-tenant');
          assert.equal(event.targets[0]?.id, 'demo-record');
          found = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 500));
      }
      assert.ok(found, `${name} event must be visible through real read API`);
      const history = await fetch(`http://127.0.0.1:4872/${name === 'nuxt' ? 'api/_logbird/events' : 'history'}`);
      assert.equal(history.status, 200, `${name} history status`);
      const historyBody = await history.text();
      assert.ok(historyBody.includes(`${name}.record.updated`), `${name} history contains event`);
      assert.ok(!historyBody.includes(ingest.secret) && !historyBody.includes(read.secret), `${name} keys stay server-side`);
      results.push({
        framework: name,
        ingest: 'real framework route -> SDK -> HTTP 202 -> ClickHouse',
        read: 'event visible with actor, tenant, target, operation',
        history: 200,
      });
      console.log(`${name}: real ingest and history read passed`);
    } finally {
      await stop(child);
    }
  }
  const host = launch('example-host-context', 'examples/hono', ['--import', 'tsx', 'sdk-host-context.ts'], env);
  try {
    await ready('http://127.0.0.1:4872/', host);
    const response = await fetch('http://127.0.0.1:4872/demo', { method: 'POST' });
    assert.equal(response.status, 200);
    const { id: apiId, jobId, operationId } = await response.json();
    const page = await readAuditTrail({ endpoint, readKey: read.secret }, { q: `operation:"${operationId}"` });
    const api = page.data.find((event) => event.id === apiId);
    const job = page.data.find((event) => event.id === jobId);
    assert.equal(api?.actor?.id, 'fictional-guard-user');
    assert.equal(api?.context.requestId, 'fictional-host-request');
    assert.equal(api?.attributes['metadata.secret'], '[redacted]');
    const detail = await fetch(`${endpoint}/v1/events/${apiId}`, { headers: { Authorization: `Bearer ${read.secret}` } });
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    const payload = typeof detailBody.payload === 'string' ? JSON.parse(detailBody.payload) : detailBody.payload;
    assert.equal(payload.metadata.secret, '[redacted]');
    assert.equal(job?.executor?.jobId, 'fictional-job');
    assert.equal(job?.executor?.attempt, 3);
    assert.equal(job?.context.parentEventId, apiId);
    assert.equal(job?.context.operationId, operationId);
    assert.equal(job?.actor?.id, 'fictional-guard-user');
    results.push({
      framework: 'sdk-host-context',
      actor: 'late guard resolved',
      requestId: 'host-provided',
      redaction: 'attributes and raw payload verified',
      worker: 'jobId, attempt 3, parentEventId and operationId verified',
    });
    console.log(
      'sdk-host-context: late actor, host requestId, redacted attributes/payload, worker jobId/attempt/parent/operation passed real readback',
    );
  } finally {
    await stop(host);
  }
  const broken = launch('example-vue-read-failure', 'examples/vue', ['--import', 'tsx', 'index.ts'], {
    ...env,
    LOGBIRD_READ_KEY: 'fictional-invalid-key',
  });
  try {
    await ready('http://127.0.0.1:4872/', broken);
    const operation = `smoke-vue-read-failure-${id}`;
    assert.equal((await fetch('http://127.0.0.1:4872/demo', { method: 'POST', headers: { 'x-logbird-operation': operation } })).status, 200);
    const failure = await fetch('http://127.0.0.1:4872/history');
    assert.equal(failure.status, 502);
    assert.ok((await failure.text()).includes('Audit history unavailable'));
    const page = await readAuditTrail({ endpoint, readKey: read.secret }, { q: `operation:"${operation}"` });
    assert.ok(
      page.data.some((event) => event.action === 'vue.record.updated'),
      'failure path flush delivered the buffered event',
    );
    assert.equal(broken.exitCode, null);
    assert.equal((await fetch('http://127.0.0.1:4872/demo', { method: 'POST' })).status, 200);
    results.push({
      framework: 'vue-read-failure',
      history: 502,
      process: 'survived; next mutation 200',
      flush: 'captured event read back after failure',
    });
    console.log('vue: read failure 502, rendered error, process alive, buffered audit event flushed');
  } finally {
    await stop(broken);
  }
  await mkdir('docs/verification/sdk-integrations', { recursive: true });
  await writeFile(
    'docs/verification/sdk-integrations/runtime-results.json',
    `${JSON.stringify({ measuredAt: new Date().toISOString(), endpoint, results, cleanup: 'owned project, keys and events removed in finally; owned processes stopped' }, null, 2)}\n`,
  );
} finally {
  for (const child of children) await stop(child);
  if (projectId) {
    const ownedProjectId = projectId;
    await withProjectLock(ownedProjectId, () => purgeProject(ch, ownedProjectId));
    await prisma.project.delete({ where: { id: projectId } });
  }
  if (orgId) await prisma.organization.delete({ where: { id: orgId } });
  await ch.close();
  await prisma.$disconnect();
}
