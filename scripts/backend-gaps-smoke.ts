import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { client, endpoint, login } from './http';

// Real HTTP regression receipt; curl headers remain private and are never logged.
const cookie = await login('demo@trailmark.local');
const api = client(cookie);
const me = (await (await api('/api/me')).json()) as { organizations: { id: string; slug: string }[] };
const organizationId = me.organizations.find((org) => org.slug === 'jood')?.id;
assert.ok(organizationId);
await api('/api/auth/organization/set-active', 'POST', { organizationId });
const created = (await (await api('/api/projects', 'POST', { name: `Backend gaps ${randomUUID()}` })).json()) as {
  project: { id: string; slug: string };
  ingestKey: { secret: string };
};
const base = `/api/projects/${created.project.id}`;
const curl = async (path: string) => {
  const { stdout } = await promisify(execFile)('curl.exe', [
    '--fail-with-body',
    '--silent',
    '--show-error',
    '-H',
    `Cookie: ${cookie}`,
    `${endpoint}${path}`,
  ]).catch(() => {
    throw new Error(`curl GET ${path} failed`);
  });
  return JSON.parse(stdout);
};
try {
  const projects = (await curl('/api/projects')) as { data: { id: string; slug: string }[] };
  const demo = projects.data.find((project) => project.slug === 'joodcms');
  assert.ok(demo);
  const actors = await curl(`/api/projects/${demo.id}/entities?kind=actor&q=scheduler&limit=100`);
  assert.ok(actors.data.length >= 24);
  assert.equal(new Set(actors.data.map((actor: { name: string }) => actor.name)).size, actors.data.length);
  console.log(
    'demo scheduler labels',
    JSON.stringify(actors.data.slice(0, 3).map((actor: { id: string; name: string }) => ({ id: actor.id, name: actor.name }))),
  );
  const since = new Date(Date.now() - 1000).toISOString();
  const event = {
    id: 'late-arrival',
    occurredAt: new Date(Date.now() - 14 * 86_400_000).toISOString(),
    action: 'gaps.checked',
    actor: { id: 'u', name: 'Named actor', email: 'u@example.test' },
    impersonator: { id: 'support' },
    tenant: { id: 'biz', name: 'Named tenant' },
    executor: { id: 'worker', name: 'Named worker', jobId: 'job-1' },
    targets: [{ type: 'record', id: 'r', name: 'Named record' }],
    context: { parentEventId: 'parent-1' },
  };
  const ingest = await fetch(`${endpoint}/v1/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${created.ingestKey.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  assert.equal(ingest.status, 202, await ingest.text());
  const status = await curl(`${base}/retention?preview=1`);
  assert.equal(status.previewDeletedEvents, 1);
  assert.equal(status.oldestEventAt, event.occurredAt);
  console.log('retention preview', JSON.stringify(status));
  for (const field of ['actor', 'tenant', 'executor', 'target']) {
    const facets = await curl(`${base}/facets?field=${field}&from=${new Date(Date.now() - 15 * 86_400_000).toISOString()}`);
    assert.match(facets.values[0].label, /^Named /);
    console.log(`facets ${field}`, JSON.stringify(facets.values));
  }
  const q =
    'impersonator:support actor.email:u@example.test parent:parent-1 tenant.name:"Named tenant" executor.name:"Named worker" (job:job-1 OR id:missing)';
  const search = await curl(`${base}/events?from=${new Date(Date.now() - 15 * 86_400_000).toISOString()}&q=${encodeURIComponent(q)}`);
  assert.equal(search.total, 1);
  console.log('query aliases + boolean', JSON.stringify({ total: search.total, ids: search.data.map((e: { id: string }) => e.id) }));
  const live = await curl(`${base}/live?since=${since}`);
  assert.deepEqual(
    live.map((e: { id: string }) => e.id),
    ['late-arrival'],
  );
  console.log(
    'live late arrival',
    JSON.stringify(
      live.map((e: { id: string; timestamp: string; receivedAt: string }) => ({ id: e.id, timestamp: e.timestamp, receivedAt: e.receivedAt })),
    ),
  );
  const histogram = await curl(`${base}/histogram?from=2020-01-01T00:00:00Z&to=2020-01-01T00:03:00Z&interval=60`);
  assert.deepEqual(
    histogram.buckets.map((b: { total: number }) => b.total),
    [0, 0, 0],
  );
  console.log('empty histogram', JSON.stringify(histogram));
  await api(base, 'PATCH', { retentionDays: 7, confirm: created.project.slug });
  const purged = await curl(`${base}/retention`);
  assert.equal(purged.lastRun.status, 'completed');
  assert.equal(purged.lastRun.deletedEvents, 1);
  assert.equal(purged.oldestEventAt, null);
  console.log('completed purge', JSON.stringify(purged));
  const invalid = await fetch(`${endpoint}${base}/events?q=${encodeURIComponent('a OR')}`, { headers: { cookie } });
  assert.equal(invalid.status, 422);
  console.log('malformed boolean status', invalid.status);
} finally {
  await api(base, 'DELETE');
}
console.log('Backend gaps HTTP regression passed');
