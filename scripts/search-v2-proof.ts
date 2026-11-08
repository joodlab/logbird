import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { client, endpoint, login } from './http';

const cookie = await login('demo@logbird.local'),
  api = client(cookie);
const me = await (await api('/api/me')).json();
await api('/api/auth/organization/set-active', 'POST', { organizationId: me.organizations.find((o: { name: string }) => o.name === 'Jood').id });
const projects = await (await api('/api/projects')).json();
const p = projects.data.find((p: { name: string }) => p.name === 'JoodCMS').id;
const from = new Date(Date.now() - 90 * 86_400_000).toISOString();
const output: string[] = [];
async function get(path: string) {
  const raw = execFileSync(
    'curl.exe',
    ['--silent', '--show-error', '--write-out', '\n%{http_code} %{time_total}', '--header', `Cookie: ${cookie}`, endpoint + path],
    { encoding: 'utf8' },
  );
  const last = raw.lastIndexOf('\n');
  const [status, seconds] = raw.slice(last + 1).split(' ');
  return { status: Number(status), curlMs: Number(seconds) * 1000, body: JSON.parse(raw.slice(0, last)) };
}
for (const [lang, q] of [
  ['query', 'attempt:>2'],
  ['query', 'action:(booking.created OR booking.cancelled)'],
  ['query', 'occurredAt:>2026-11-01'],
  ['query', String.raw`action:/booking\..*/`],
  ['sql', 'job_attempt > 2'],
  ['sql', "attributes['metadata.channel'] = 'whatsapp'"],
  ['sql', '1 OR 1'],
  ['sql', "arrayExists(x -> startsWith(x, 'bk_'), target_ids)"],
  ['sql', '1) OR (1=1'],
  ['sql', "project_id = 'other'"],
  ['sql', 'sleep(3) = 0'],
  ['sql', '1; DROP TABLE events'],
  ['sql', "match(description, concat('(?:', replaceRegexpAll(description,'[^a-zA-Z0-9]',''), '){10}'))"],
]) {
  const r = await get(`/api/projects/${p}/events?${new URLSearchParams({ lang: lang!, q: q!, from, limit: '3' })}`);
  output.push(JSON.stringify({ lang, q, status: r.status, ...(r.status === 200 ? { total: r.body.total, tookMs: r.body.tookMs } : r.body) }));
  if (q === '1 OR 1') assert.ok(r.body.data.every((e: { projectId: string }) => e.projectId === p));
}
for (const field of ['action', 'actor', 'actor.name', 'target', 'target.type', 'source', 'metadata.channel']) {
  const start = performance.now();
  const r = await get(`/api/projects/${p}/suggest?${new URLSearchParams({ field, limit: '3' })}`);
  output.push(JSON.stringify({ suggest: field, tookMs: r.curlMs, processMs: performance.now() - start, ...r }));
  assert.equal(r.status, 200);
}
await mkdir('.tmp', { recursive: true });
await writeFile('.tmp/search-v2-evidence.jsonl', `${output.join('\n')}\n`);
console.log(output.join('\n'));
