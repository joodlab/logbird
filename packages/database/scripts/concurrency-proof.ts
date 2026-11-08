import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';

const dbUrl = new URL(process.env.DATABASE_URL!);
dbUrl.searchParams.set('connection_limit', '2');
const appName = `followups-smallpool-${randomUUID()}`;
dbUrl.searchParams.set('application_name', appName);
process.env.DATABASE_URL = dbUrl.toString();
const { prisma, closeProjectLocks } = await import('../src/index');
const { app } = await import('../../../apps/server/src/app');
const { clickhouse, enforceProjectRetention } = await import('../../../apps/worker/src/retention');
const { closeRetentionQueue } = await import('../../../apps/worker/src/queue');
const serverCh = await import('../../../apps/server/src/clickhouse');
const { rateLimitStore } = await import('../../../apps/server/src/rate-limit');
const evidence: unknown[] = [];
const baseline = new Pool({ connectionString: dbUrl.toString(), max: 2 });
let releasePurge!: () => void;
let purge: Promise<unknown> | undefined;
try {
  // Reproduce the old topology without hanging or killing shared sessions.
  const holder = await baseline.connect();
  const waiter = await baseline.connect();
  const key = `deadlock-fixture-${randomUUID()}`;
  await holder.query('BEGIN');
  await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
  await waiter.query('BEGIN');
  let waiterDone = false,
    nestedDone = false;
  const waiting = waiter.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]).then(() => {
    waiterDone = true;
  });
  const nested = baseline.query('SELECT 1').then(() => {
    nestedDone = true;
  });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(waiterDone, false);
  assert.equal(nestedDone, false);
  assert.equal(baseline.waitingCount, 1);
  evidence.push({
    before: 'two-connection pool deadlock reproduced',
    lockWaiter: !waiterDone,
    nestedGlobalQueryQueued: !nestedDone,
    poolWaiting: baseline.waitingCount,
  });
  await holder.query('ROLLBACK');
  holder.release();
  await waiting;
  await waiter.query('ROLLBACK');
  waiter.release();
  await nested;
  await baseline.end();

  let cookie = '';
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const start = performance.now();
    const response = await app.request(path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', Origin: process.env.APP_URL! },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      ms: performance.now() - start,
      body: text ? JSON.parse(text) : null,
      retryAfter: response.headers.get('Retry-After'),
      cookie: response.headers
        .getSetCookie()
        .map((v) => v.split(';')[0])
        .join('; '),
    };
  };
  const email = `concurrency-${randomUUID()}@example.test`;
  assert.equal((await request('/api/auth/email-otp/send-verification-otp', 'POST', { email, type: 'sign-in' })).status, 200);
  const mailbox = await (await fetch('http://127.0.0.1:8025/api/v1/messages')).json();
  const message = mailbox.messages.find((m: { To: { Address: string }[] }) => m.To.some((t) => t.Address === email));
  const content = await (await fetch(`http://127.0.0.1:8025/api/v1/message/${message.ID}`)).json();
  const login = await request('/api/auth/sign-in/email-otp', 'POST', { email, otp: content.Text.match(/\b\d{6}\b/)?.[0] });
  assert.equal(login.status, 200);
  cookie = login.cookie;
  const org = await request('/api/auth/organization/create', 'POST', { name: 'Concurrency fixture', slug: `concurrency-${randomUUID()}` });
  await request('/api/auth/organization/set-active', 'POST', { organizationId: org.body.id });
  const a = (await request('/api/projects', 'POST', { name: 'Long purge fixture A' })).body.project.id;
  const b = (await request('/api/projects', 'POST', { name: 'Healthy fixture B' })).body.project.id;
  for (const p of [a, b]) assert.equal((await request(`/api/projects/${p}/test-event`, 'POST')).status, 202);
  const original = clickhouse.command.bind(clickhouse);
  let entered!: () => void;
  const entry = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    releasePurge = r;
  });
  let held = false;
  clickhouse.command = async (params) => {
    if (!held && params.query.startsWith('DELETE FROM events ') && params.query_params?.p === a) {
      held = true;
      entered();
      await gate;
    }
    return original(params);
  };
  purge = enforceProjectRetention(a);
  await entry;
  const started = performance.now();
  const endpoints = ['events', 'histogram', 'facets?field=action', 'overview', 'entities?kind=actor', 'fields', 'suggest?field=action', 'setup'];
  const requests = await Promise.all([
    ...Array.from({ length: 50 }, (_, i) =>
      request(`/api/projects/${b}/${endpoints[i % endpoints.length]}`).then((r) => ({ group: 'B read', ...r })),
    ),
    ...Array.from({ length: 50 }, () => request(`/api/projects/${a}/events`).then((r) => ({ group: 'A read', ...r }))),
    request(`/api/projects/${b}/test-event`, 'POST').then((r) => ({ group: 'B ingest', ...r })),
    request('/readyz').then((r) => ({ group: 'readyz', ...r })),
    request(`/api/projects/${a}/test-event`, 'POST').then((r) => ({ group: 'A ingest', ...r })),
    request(`/api/projects/${a}/sample-data`, 'DELETE').then((r) => ({ group: 'A sample removal', ...r })),
    request(`/api/projects/${a}`, 'DELETE').then((r) => ({ group: 'A project deletion', ...r })),
  ]);
  for (const r of requests) {
    assert.equal(r.status, r.group.startsWith('A ') ? 503 : r.group === 'B ingest' ? 202 : 200, `${r.group}: ${JSON.stringify(r.body)}`);
    assert.ok(r.ms < 5000, `${r.group} took ${r.ms}ms`);
    if (r.group.startsWith('A ')) assert.equal(r.retryAfter, '1');
  }
  const sessions = await prisma.$queryRaw<{ idleTransactions: bigint; lockWaiters: bigint; sessions: bigint }[]>`
    SELECT count(*) FILTER (WHERE state='idle in transaction') AS "idleTransactions",
      count(*) FILTER (WHERE wait_event='advisory') AS "lockWaiters", count(*) AS sessions
    FROM pg_stat_activity WHERE application_name=${appName}`;
  assert.equal(Number(sessions[0]?.idleTransactions), 0);
  assert.equal(Number(sessions[0]?.lockWaiters), 0);
  assert.ok(Number(sessions[0]?.sessions) <= 2);
  await new Promise((r) => setTimeout(r, 2000));
  evidence.push({
    after: 'ClickHouse DELETE paused; connection_limit=2',
    elapsedMs: performance.now() - started,
    sessions: sessions.map((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(v)]))),
    requests: requests.map(({ group, status, ms, retryAfter }) => ({ group, status, ms, retryAfter })),
  });
  releasePurge();
  await purge;
  assert.equal((await request(`/api/projects/${a}/events`)).status, 200);
  evidence.push({ purgeCompleted: true, projectA: a, projectB: b });
  console.log(JSON.stringify({ verified: true, requests: requests.length }));
} finally {
  releasePurge?.();
  await purge?.catch(() => undefined);
  await mkdir('.tmp', { recursive: true });
  await writeFile('.tmp/server-concurrency-evidence.json', `${JSON.stringify(evidence, null, 2)}\n`);
  await Promise.allSettled([
    baseline.end(),
    closeProjectLocks(),
    prisma.$disconnect(),
    closeRetentionQueue(),
    clickhouse.close(),
    serverCh.clickhouse.close(),
    serverCh.queryClickhouse?.close(),
    rateLimitStore.quit(),
  ]);
}
