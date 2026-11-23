// From the delivery checkout, after frozen installs and Prisma generation here and at v0.2.1:
// node --env-file=.env --import tsx scripts/webhook-upgrade-proof.ts logbird_t2_scratch_webhooks <v0.2.1-worktree> [--suites]
// Uses local Postgres, ClickHouse, Redis and Mailpit. The database name must be unused.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { freemem } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createClickHouseClient, createMaintenanceClickHouseClient, purgeProject, read } from '@logbird/clickhouse';
import { createProjectResponseSchema, createWebhookResponseSchema, ingestResponseSchema, webhookEndpointSchema } from '@logbird/contracts';
import { verifyWebhook } from '@logbird/sdk';
import { Client } from 'pg';

const [name, baseline, suites] = process.argv.slice(2);
assert(name && /^logbird_t2_scratch_[a-z0-9_]{1,40}$/.test(name), 'Pass an unused logbird_t2_scratch_* database name');
assert(baseline && (!suites || suites === '--suites') && process.argv.length <= 5, 'Pass the pre-delivery worktree and optional --suites');
const oldRoot = resolve(baseline);
const newRoot = resolve(import.meta.dirname, '..');
const rolloutMigration = 'packages/database/prisma/migrations/20261122140000_webhook_deliveries';
assert(
  existsSync(resolve(oldRoot, 'apps/server/src/index.ts')) && !existsSync(resolve(oldRoot, rolloutMigration)),
  'Expected a pre-delivery worktree',
);

function localUrl(value: string | undefined, label: string) {
  assert(value, `Missing ${label}`);
  const url = new URL(value);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), `Expected a loopback ${label}`);
  return url;
}

const adminUrl = localUrl(process.env.DATABASE_URL, 'DATABASE_URL');
localUrl(process.env.CLICKHOUSE_URL, 'CLICKHOUSE_URL');
localUrl(process.env.REDIS_URL, 'REDIS_URL');
assert(['localhost', '127.0.0.1', '::1'].includes(process.env.SMTP_HOST ?? ''), 'Expected loopback SMTP_HOST for Mailpit');
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${name}`;
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.toString() });
const servers = new Set<ChildProcess>();
const streams: string[] = [];
const email = `qa-webhook-upgrade-${randomUUID()}@example.invalid`;
const secrets = new Map<string, string>();
const received = new Map<string, { id: string; receivedAt: string; header: string }[]>();
let rejected = 0;
const receiver = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    const path = req.url ?? '';
    const secret = secrets.get(path);
    assert(secret);
    req.setEncoding('utf8');
    let payload = '';
    for await (const chunk of req) payload += chunk;
    const { id, receivedAt } = await verifyWebhook<{ id: string; receivedAt: string }>({ payload, headers: req.headers, secret });
    const header = req.headers['webhook-id'];
    assert(typeof header === 'string' && header.startsWith('lb1_'));
    const events = received.get(path) ?? [];
    events.push({ id, receivedAt, header });
    received.set(path, events);
    res.writeHead(204).end();
  } catch {
    rejected++;
    res.writeHead(400).end();
  }
});

function freeMemory() {
  assert(freemem() >= 5 * 1024 ** 3, 'Wait for at least 5 GiB free RAM before starting another command');
}

function start(args: string[], cwd: string, env = process.env, quiet = false) {
  freeMemory();
  const child = spawn(process.execPath, args, { cwd, env, stdio: quiet ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  const finished = once(child, 'exit');
  return { child, finished };
}

async function run(args: string[], cwd: string) {
  const { child, finished } = start(args, cwd);
  const memory = setInterval(() => {
    if (freemem() < 2 * 1024 ** 3) child.kill();
  }, 1000);
  try {
    assert.equal((await finished)[0], 0, `${args[0]} exited unsuccessfully`);
  } finally {
    clearInterval(memory);
  }
}

async function startServer(root: string, port: number) {
  const { child, finished } = start(['--import', 'tsx', 'src/index.ts'], resolve(root, 'apps/server'), { ...process.env, PORT: String(port) }, true);
  servers.add(child);
  await new Promise<void>((ready, fail) => {
    const timeout = setTimeout(() => fail(new Error(`API on port ${port} did not start`)), 20_000);
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-8192);
      if (output.includes(`"event":"server.ready","port":${port}`)) {
        clearTimeout(timeout);
        ready();
      }
    });
    finished.then(() => {
      clearTimeout(timeout);
      fail(new Error(`API on port ${port} exited`));
    }, fail);
  });
  return `http://127.0.0.1:${port}`;
}

async function stopServers() {
  for (const child of servers) {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    servers.delete(child);
  }
}

async function ports() {
  const available: number[] = [];
  for (let port = 4720; port <= 4729 && available.length < 2; port++) {
    const probe = createServer().listen(port, '127.0.0.1');
    try {
      await once(probe, 'listening');
      available.push(port);
      await new Promise<void>((done) => probe.close(() => done()));
    } catch {
      // Another local process owns this port.
    }
  }
  assert(available[0] && available[1], 'Need two free ports in 4720–4729');
  return [available[0], available[1]] as const;
}

async function migrate(root: string) {
  await run([resolve(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], resolve(root, 'packages/database'));
}

async function purgeLoginMail() {
  const mailbox = 'http://127.0.0.1:8025/api/v1';
  const result = await fetch(`${mailbox}/search?${new URLSearchParams({ query: `to:${email}` })}`);
  assert(result.ok, 'Mailpit search');
  const { messages } = (await result.json()) as { messages: { ID: string; To: { Address: string }[] }[] };
  const IDs = messages.filter((message) => message.To.some(({ Address }) => Address === email)).map(({ ID }) => ID);
  if (!IDs.length) return;
  const removed = await fetch(`${mailbox}/messages`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ IDs }),
  });
  assert(removed.ok, 'Mailpit fixture cleanup');
}

let mine = false;
let loginStarted = false;
const errors: unknown[] = [];
try {
  freeMemory();
  await admin.connect();
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  assert.equal(existing.rowCount, 0, `Scratch database ${name} already exists. Stopping without changing it.`);
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  mine = true;
  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.BULLMQ_PREFIX = '{logbird-t2w}';
  process.env.AUTH_SIGNUP = 'open';
  process.env.NODE_ENV = 'development';
  const [oldPort, newPort] = await ports();
  process.env.APP_URL = `http://127.0.0.1:${oldPort}`;
  process.env.SERVER_URL = process.env.APP_URL;
  const { login, client } = await import('./http');

  await migrate(oldRoot);
  const oldApi = await startServer(oldRoot, oldPort);
  loginStarted = true;
  const cookie = await login(email);
  const old = client(cookie);
  const org = (await (
    await old('/api/auth/organization/create', 'POST', {
      name: 'QA webhook upgrade',
      slug: `qa-webhook-upgrade-${randomUUID()}`,
    })
  ).json()) as { id: string };
  streams.push(`ws:${org.id}`);
  await old('/api/auth/organization/set-active', 'POST', { organizationId: org.id });
  const project = createProjectResponseSchema.parse(await (await old('/api/projects', 'POST', { name: 'QA webhook upgrade' })).json());
  const projectId = project.project.id;
  streams.push(projectId);
  const base = `/api/projects/${projectId}/webhooks`;
  const filterQuery = 'action:qa.matches';
  const createEndpoint = async (description: string, filter = '') =>
    createWebhookResponseSchema.parse(await (await old(base, 'POST', { url: 'https://8.8.8.8/qa', description, filterQuery: filter })).json());
  const empty = await createEndpoint('QA existing empty filter');
  const filtered = await createEndpoint('QA existing non-empty filter', filterQuery);
  async function ingest(api: string, events: { id: string; action: string }[]) {
    const response = await fetch(`${api}/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${project.ingestKey.secret}` },
      body: JSON.stringify({ events }),
    });
    assert.equal(response.status, 202, 'Ingest HTTP status');
    const result = ingestResponseSchema.parse(await response.json());
    assert.deepEqual(
      result.ids,
      events.map(({ id }) => id),
    );
  }
  const pre = ['qa-pre-01', 'qa-pre-02'];
  await ingest(
    oldApi,
    pre.map((id) => ({ id, action: 'qa.matches' })),
  );
  await migrate(newRoot);
  const rolling = await createEndpoint('QA created on old API after migration');
  const newApi = await startServer(newRoot, newPort);
  const db = await import('@logbird/database');
  const { webhookCursorClock, webhookSecretKey } = await import('@logbird/database/webhooks');
  const { scanWebhooks } = await import('../apps/worker/src/webhook-discovery');
  const { deliverWebhooks } = await import('../apps/worker/src/webhook-delivery');
  const ch = createClickHouseClient();
  try {
    const [identity] = await db.prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    assert.equal(identity?.name, name);
    const refetch = (id: string) => db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } });
    const { rollout } = await webhookCursorClock(db.prisma);
    for (const [fixture, held] of [
      [empty, false],
      [filtered, true],
    ] as const) {
      const row = await refetch(fixture.endpoint.id);
      assert.deepEqual(row.cursorReceivedAt, rollout);
      assert.equal(row.cursorReviewRequired, false);
      assert.equal(row.filterReviewRequired, held);
      assert.equal(row.lastScannedAt, null);
    }
    const rollingRow = await refetch(rolling.endpoint.id);
    assert(+rollingRow.createdAt >= +rollout);
    assert.equal(rollingRow.filterReviewRequired, false);
    assert.equal(rollingRow.lastScannedAt, null);

    // Save via the real API with its address guard. Change only the test DB's URL to
    // point at the receiver, then allow only loopback at the in-process worker transport.
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    const { port } = receiver.address() as AddressInfo;
    for (const { endpoint, secret } of [empty, filtered, rolling]) {
      const path = `/${endpoint.id}`;
      secrets.set(path, secret);
      await db.prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { url: `http://127.0.0.1:${port}${path}` } });
    }
    const untrustedAt = new Date(+rollout + 86_400_000);
    const untrusted = await db.prisma.webhookEndpoint.create({
      data: { projectId, url: 'https://8.8.8.8/qa', description: 'QA deliberately future cursor', cursorReceivedAt: untrustedAt },
    });
    const post = ['qa-post-01', 'qa-post-02', 'qa-post-03'] as const;
    await ingest(newApi, [
      { id: post[0], action: 'qa.matches' },
      { id: post[1], action: 'qa.other' },
      { id: post[2], action: 'qa.matches' },
    ]);
    const events = await read<{ id: string; ms: number }>(
      ch,
      `SELECT event_id AS id, toUnixTimestamp64Milli(received_at) AS ms
      FROM events WHERE project_id = {projectId:String} ORDER BY received_at, event_id`,
      { projectId },
    );
    assert.deepEqual(
      events.map(({ id }) => id),
      [...pre, ...post],
    );
    assert(events.slice(0, pre.length).every(({ ms }) => ms < +rollout));
    assert(events.slice(pre.length).every(({ ms }) => ms >= Math.max(+rollout, +rollingRow.createdAt)));

    const delivered = (id: string) => received.get(`/${id}`) ?? [];
    const pass = async () => {
      await scanWebhooks(ch);
      await deliverWebhooks(
        ch,
        {
          secretKey: webhookSecretKey(process.env.BETTER_AUTH_SECRET ?? '', process.env.WEBHOOK_SECRET_KEY || undefined),
          concurrency: 4,
          perEndpoint: 1,
          failureLimit: 50,
          transport: { allowHttp: true, allowAddress: (address) => address === '127.0.0.1' },
        },
        projectId,
      );
    };
    async function drain(endpointId: string, count: number) {
      const deadline = performance.now() + 45_000;
      do {
        await pass();
        if (delivered(endpointId).length >= count) return;
        await delay(250);
      } while (performance.now() < deadline);
      assert.fail(`Expected ${count} signed POSTs, observed ${delivered(endpointId).length}`);
    }
    const update = async (id: string, body: object) => {
      const response = await fetch(`${newApi}${base}/${id}`, {
        method: 'PATCH',
        headers: { cookie, Origin: oldApi, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return webhookEndpointSchema.parse(await response.json());
    };
    await drain(empty.endpoint.id, 3);
    await drain(rolling.endpoint.id, 3);
    const held = await refetch(filtered.endpoint.id);
    assert.equal(held.filterReviewRequired, true);
    assert.equal(held.cursorReviewRequired, false);
    assert.deepEqual(held.cursorReceivedAt, rollout);
    assert.equal(held.lastScannedAt, null);
    assert.equal(await db.prisma.webhookDelivery.count({ where: { endpointId: held.id } }), 0);
    assert.deepEqual(delivered(held.id), []);
    assert.equal((await update(held.id, { description: 'QA still held' })).filterWarning, 'webhook_filter_review_required');
    const confirmed = await update(held.id, { filterQuery });
    assert.equal(confirmed.filterWarning, undefined);
    assert.equal(confirmed.cursorWarning, undefined);
    await drain(held.id, 2);
    await pass();
    const expected = [
      [empty.endpoint.id, post],
      [rolling.endpoint.id, post],
      [held.id, [post[0], post[2]]],
    ] as const;
    for (const [id, ids] of expected) {
      const posts = delivered(id);
      assert.deepEqual(
        posts.map((event) => event.id),
        ids,
      );
      assert.deepEqual(
        posts.map(({ receivedAt }) => +new Date(receivedAt)),
        ids.map((eventId) => events.find(({ id: storedId }) => storedId === eventId)?.ms),
      );
      const rows = await db.prisma.webhookDelivery.findMany({ where: { endpointId: id }, orderBy: [{ receivedAt: 'asc' }, { eventId: 'asc' }] });
      assert.deepEqual(
        rows.map(({ eventId, status, attemptNumber, webhookId }) => ({ eventId, status, attemptNumber, webhookId })),
        posts.map(({ id: eventId, header: webhookId }) => ({ eventId, webhookId, status: 'succeeded', attemptNumber: 1 })),
      );
    }
    assert.equal(rejected, 0);
    const warned = await db.prisma.webhookEndpoint.findMany({ where: { cursorReviewRequired: true } });
    assert.deepEqual(
      warned.map(({ id }) => id),
      [untrusted.id],
    );
    assert.deepEqual(warned[0]?.cursorReceivedAt, untrustedAt);
    assert.deepEqual(delivered(untrusted.id), []);
    console.log(
      JSON.stringify(
        {
          rollout,
          rolling: {
            createdAt: rollingRow.createdAt,
            cursor: rollingRow.cursorReceivedAt,
            deltaMs: +rollingRow.createdAt - +rollingRow.cursorReceivedAt,
          },
          events: events.map(({ id, ms }) => ({ id, receivedAt: new Date(ms) })),
          signedPosts: {
            existing: delivered(empty.endpoint.id).map(({ id }) => id),
            rolling: delivered(rolling.endpoint.id).map(({ id }) => id),
            filteredBeforeConfirmation: 0,
            filteredAfterConfirmation: delivered(held.id).map(({ id }) => id),
          },
          cursorReviews: { ordinary: 0, future: 1, cursor: untrustedAt },
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all([ch.close(), db.prisma.$disconnect(), db.closeProjectLocks()]);
  }

  await stopServers();
  if (suites === '--suites') {
    const vitest = resolve(newRoot, 'node_modules/vitest/vitest.mjs');
    const results: unknown[] = [];
    for (const role of ['worker', 'server']) {
      try {
        await run([vitest, 'run', 'src/webhook', '--maxWorkers=1', '--reporter=verbose'], resolve(newRoot, 'apps', role));
      } catch (error) {
        results.push(error);
      }
    }
    if (results.length) throw new AggregateError(results, 'Webhook suites failed');
  }
} catch (error) {
  errors.push(error);
} finally {
  await stopServers();
  receiver.closeAllConnections();
  await new Promise<void>((done) => receiver.close(() => done()));
  try {
    const cleanup = async () => {
      if (!streams.length) return;
      const maintenance = createMaintenanceClickHouseClient();
      try {
        for (const stream of streams) {
          await purgeProject(maintenance, stream);
          console.log(`Purged proof stream ${stream}`);
        }
      } finally {
        await maintenance.close();
      }
    };
    const results = await Promise.allSettled([cleanup(), loginStarted && purgeLoginMail()]);
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
  } finally {
    try {
      if (mine) {
        await admin.query(`DROP DATABASE "${name}"`);
        console.log(`Dropped scratch database ${name}`);
      }
    } finally {
      await admin.end();
    }
  }
}
for (const error of errors) console.error(error);
if (errors.length) process.exitCode = 1;
