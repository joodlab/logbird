import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { prisma } from '@logbird/database';
import { closeRetentionQueue } from '../apps/worker/src/queue';
import { clickhouse, enforceProjectRetention } from '../apps/worker/src/retention';
import { client, endpoint, login } from './http';

const evidence: unknown[] = [];
const cookie = await login(`followups-${randomUUID()}@example.test`);
const api = client(cookie);
const org = await (
  await api('/api/auth/organization/create', 'POST', { name: 'Server followups fixture', slug: `followups-${randomUUID()}` })
).json();
await api('/api/auth/organization/set-active', 'POST', { organizationId: org.id });
const created = await (await api('/api/projects', 'POST', { name: 'Retention lease fixture' })).json();
const p = created.project.id;
await api('/api/projects', 'POST', { name: 'Healthy neighbor fixture' });
function curl(path: string) {
  const start = performance.now();
  const output = execFileSync('curl.exe', ['-sS', '-H', `Cookie: ${cookie}`, '-w', '\n%{http_code}', `${endpoint}${path}`], { encoding: 'utf8' });
  const split = output.lastIndexOf('\n');
  const status = Number(output.slice(split + 1));
  const body = JSON.parse(output.slice(0, split));
  evidence.push({ command: `curl -sS <authenticated> '${path}'`, status, body, elapsedMs: Math.round((performance.now() - start) * 100) / 100 });
  return { status, body };
}
try {
  const r = await fetch(`${endpoint}/v1/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${created.ingestKey.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      events: [
        { action: 'fixture.a', outcome: 'failure', metadata: { plan: 'pro' } },
        { action: 'fixture.a', outcome: 'failure', metadata: { plan: 'pro' } },
        { action: 'fixture.b', outcome: 'success', metadata: { plan: 'free' } },
      ],
    }),
  });
  assert.equal(r.status, 202, await r.text());
  const run = await prisma.retentionRun.create({ data: { projectId: p, retentionDays: 30, cutoff: new Date(), status: 'running' } });
  assert.equal(curl(`/api/projects/${p}/events`).status, 503);
  const workspace = curl('/api/workspace/setup');
  assert.equal(workspace.status, 200);
  assert.equal(workspace.body.projects.find((v: { projectId: string }) => v.projectId === p).retentionBusy, true);
  assert.equal(workspace.body.projects.length, 2);
  // Only this script's fictional run is aged, simulating a killed process.
  const expired = new Date(Date.now() - 11 * 60_000);
  await prisma.retentionRun.update({ where: { id: run.id }, data: { startedAt: expired, heartbeatAt: expired } });
  assert.equal(curl(`/api/projects/${p}/events`).status, 200);
  const recovered = await prisma.retentionRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error, 'abandoned');
  evidence.push({ recovery: { id: recovered.id, status: recovered.status, error: recovered.error, finishedAt: recovered.finishedAt } });
  for (let attempt = 0; ; attempt++) {
    const response = curl(`/api/projects/${p}/events`);
    if (response.status === 200) break;
    assert.equal(response.status, 503);
    assert.ok(attempt < 240);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await enforceProjectRetention(p);
  assert.equal((await prisma.retentionRun.findFirstOrThrow({ where: { projectId: p }, orderBy: { startedAt: 'desc' } })).status, 'completed');
  const values = curl(`/api/projects/${p}/suggest?field=metadata.plan`);
  assert.equal(values.status, 200);
  assert.deepEqual(
    values.body.values.map((v: { value: string; count: number }) => [v.value, v.count]),
    [
      ['pro', 2],
      ['free', 1],
    ],
  );
  assert.equal(values.body.complete, true);
  assert.equal(curl(`/api/projects/${p}/suggest?field=metadata.plan&limit=1`).body.complete, false);
  for (const [lang, q] of [
    ['query', 'outcome:failure'],
    ['sql', "outcome = 'failure'"],
  ]) {
    const result = curl(`/api/projects/${p}/suggest?${new URLSearchParams({ field: 'metadata.plan', lang, q })}`);
    assert.equal(result.status, 200);
    assert.deepEqual(
      result.body.values.map((v: { value: string }) => v.value),
      ['pro'],
    );
  }
  for (const q of ['_exists_:metadata.plan', 'occurredAt:[now-24h TO now]'])
    assert.equal(curl(`/api/projects/${p}/events?${new URLSearchParams({ q })}`).body.total, 3);
  assert.ok(curl(`/api/projects/${p}/events?q=actor%20%3D%20user`).body.error.details.replacement);
  const sql = curl(`/api/projects/${p}/events?lang=sql&q=action%20%3D`);
  assert.equal(sql.status, 422);
  assert.equal(sql.body.error.details.reason, 'syntax');
  // Read-only timing probe of the existing 300k-event project.
  const demo = await prisma.project.findFirst({ where: { name: 'StayDesk' } });
  if (demo) {
    const { suggestValues } = await import('@logbird/clickhouse');
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const result = await suggestValues(clickhouse, demo.id, { field: 'metadata.locale', limit: 10 });
      evidence.push({ timing: 'StayDesk attribute suggestions', elapsedMs: performance.now() - started, ...result });
    }
  }
  console.log(JSON.stringify({ verified: true, projectId: p, evidence: evidence.length }));
} finally {
  await writeFile('docs/server-followups-evidence.json', `${JSON.stringify(evidence, null, 2)}\n`);
  await Promise.all([prisma.$disconnect(), clickhouse.close(), closeRetentionQueue()]);
}
