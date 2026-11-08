/**
 * Real dev-chain check of the console's API forwarding (Vite + Nitro dev server in front of the Hono server).
 *
 *   SERVER_URL=http://localhost:4600 node --env-file=.env --import tsx scripts/dev-proxy-check.ts [out.json]
 *
 * Run against a running `pnpm dev` stack on its own (it creates and removes a fictional QA workspace). Oracle: Hono
 * answers every request with `X-Request-Id`; the console (Nitro/Vite) does not. Raw request lines are sent with
 * node:http so dot segments and encoded dots reach the dev server unnormalized. Exits 1 on any unexpected result.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createClickHouseClient, purgeProject } from '@logbird/clickhouse';
import * as s from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { client, endpoint, login } from './http';

const base = new URL(endpoint);
const origin = process.env.APP_URL ?? 'http://localhost:4600';
type Result = { name: string; method: string; path: string; dest: string; status: number; hono: boolean; ok: boolean; expect: string };
const results: Result[] = [];

function raw(method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; hono: boolean; text: string }>((resolve, reject) => {
    const req = request(
      {
        host: base.hostname,
        port: base.port,
        method,
        path,
        headers: body ? { ...headers, 'content-length': String(Buffer.byteLength(body)) } : headers,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, hono: Boolean(res.headers['x-request-id']), text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function check(
  name: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  expect: { status?: number; hono: boolean; contains?: string },
  body?: string,
) {
  const r = await raw(method, path, headers, body);
  const ok =
    r.hono === expect.hono && (expect.status === undefined || r.status === expect.status) && (!expect.contains || r.text.includes(expect.contains));
  results.push({
    name,
    method,
    path,
    dest: headers['sec-fetch-dest'] ?? '-',
    status: r.status,
    hono: r.hono,
    ok,
    expect: `${expect.status ?? 'any'}/${expect.hono ? 'hono' : 'console'}`,
  });
}

const email = `qa-fix-devproxy-${randomUUID().slice(0, 8)}@example.test`;
const ch = createClickHouseClient();
let organizationId: string | undefined;
let exitCode = 0;
try {
  const cookie = await login(email);
  const api = client(cookie);
  const org = (await (
    await api('/api/auth/organization/create', 'POST', { name: 'QA Fix devproxy', slug: `qa-fix-devproxy-${randomUUID().slice(0, 8)}` })
  ).json()) as { id: string };
  organizationId = org.id;
  await api('/api/auth/organization/set-active', 'POST', { organizationId });
  const created = s.createProjectResponseSchema.parse(await (await api('/api/projects', 'POST', { name: 'QA Fix devproxy' })).json());
  const p = created.project;
  const read = s.createApiKeyResponseSchema.parse(await (await api(`/api/projects/${p.id}/keys`, 'POST', { name: 'Read', kind: 'read' })).json());
  const json = { accept: 'application/json', 'content-type': 'application/json' };
  const session = { ...json, cookie, origin };
  const ingest = { ...json, authorization: `Bearer ${created.ingestKey.secret}` };
  const reader = { ...json, authorization: `Bearer ${read.secret}` };
  const fetchLike = { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' };

  // Ordinary reads and writes.
  await check('session read', 'GET', '/api/projects', session, { status: 200, hono: true });
  await check(
    'ingest write',
    'POST',
    '/v1/events',
    ingest,
    { status: 202, hono: true },
    JSON.stringify([
      { id: 'qa-receipt.png', action: 'qa.dotted_id' },
      { id: 'qa-bundle.js', action: 'qa.dotted_id' },
    ]),
  );
  await check('public search read', 'GET', '/v1/events?limit=5', reader, { status: 200, hono: true });
  // Dotted ids (asset extensions) through the console, as curl/SDK and as a browser fetch.
  for (const extra of [{}, fetchLike]) {
    const how = 'sec-fetch-dest' in extra ? 'fetch' : 'plain';
    await check(
      `dotted /v1 read (${how})`,
      'GET',
      '/v1/events/qa-receipt.png',
      { ...reader, ...extra },
      { status: 200, hono: true, contains: 'qa-receipt.png' },
    );
    await check(
      `dotted /api read (${how})`,
      'GET',
      `/api/projects/${p.id}/events/qa-bundle.js`,
      { ...session, ...extra },
      { status: 200, hono: true, contains: 'qa-bundle.js' },
    );
    await check(`dotted /api write (${how})`, 'DELETE', `/api/projects/${p.id}/views/qa-missing.svg`, { ...session, ...extra }, { hono: true });
  }
  // Reference methods.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
    for (const path of ['/docs', '/openapi.json']) await check('reference method', method, path, session, { status: 405, hono: false });
  for (const path of ['/docs', '/openapi.json']) await check('reference read', 'GET', path, session, { status: 200, hono: true });
  // Raw traversal / encoded dots with asset and document fetch modes and fictional credentials.
  const credentials = { cookie: 'better-auth.session_token=fixture-session', authorization: 'Bearer lb_read_fixture' };
  const toReference = ['/api/../docs', '/api/%2e%2e/openapi.json', '/api/%2E%2E/docs', '/v1/../openapi.json'];
  const toPrivate = ['/v1/../internal', '/api/../metrics', '/v1/%2e%2e/internal', '/api/%2e%2e/internal', '/api/%2E%2E/server-only-probe'];
  for (const dest of ['image', 'script', 'document']) {
    const headers = { ...credentials, 'sec-fetch-dest': dest };
    for (const path of toReference) {
      await check('traversal to reference (POST)', 'POST', path, headers, { status: 405, hono: false }, '{}');
      await check('traversal to reference (GET)', 'GET', path, headers, { status: 200, hono: true });
    }
    for (const path of toPrivate)
      for (const method of ['POST', 'GET'])
        await check('traversal to private path', method, path, headers, { hono: false }, method === 'POST' ? '{}' : undefined);
  }
  await api(`/api/projects/${p.id}?confirm=${encodeURIComponent(p.slug)}`, 'DELETE');
} catch (error) {
  exitCode = 1;
  console.error('check aborted:', error instanceof Error ? error.message : error);
} finally {
  await new Promise((r) => setTimeout(r, 10_000)); // let the audit outbox drain before purging the fixture's activity
  if (organizationId) {
    for (const project of await prisma.project.findMany({ where: { organizationId } })) await purgeProject(ch, project.id);
    await purgeProject(ch, `ws:${organizationId}`);
    await prisma.organization.delete({ where: { id: organizationId } });
  }
  await prisma.user.deleteMany({ where: { email } });
  await fetch(`http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`, { method: 'DELETE' }).catch(() => undefined);
  await ch.close();
  await prisma.$disconnect();
}
const failed = results.filter((r) => !r.ok);
const out = process.argv[2];
if (out)
  writeFileSync(
    out,
    `${JSON.stringify({ at: new Date().toISOString(), base: endpoint, total: results.length, failed: failed.length, results }, null, 2)}\n`,
  );
for (const r of results)
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'} ${r.method.padEnd(7)} ${r.path.padEnd(52)} dest=${r.dest.padEnd(8)} -> ${r.status} ${r.hono ? 'hono' : 'console'} (expected ${r.expect})`,
  );
console.log(`${results.length - failed.length}/${results.length} passed`);
assert.ok(results.length > 0);
process.exit(failed.length || exitCode ? 1 : 0);
