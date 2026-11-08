/**
 * Proof that the public origin serves the API reference and nothing else from the API listener (#61).
 *
 *   BASE_URL=http://localhost:4600 node scripts/docs-proof.mjs <outDir> [--insecure] [--echo]
 *
 * 1. HTTP: /docs and /openapi.json return 200 through the console; unknown server-style paths are answered by the
 *    console (HTML), never by the API's JSON 404; POST/PUT/PATCH/DELETE/OPTIONS on the reference get the console's 405.
 *    With --echo (console's LOGBIRD_SERVER_URL pointed at a header-echo server), it records which credentials reach
 *    the upstream per path and skips the browser step.
 * 2. Browser (Playwright's bundled Chromium, fresh context): /docs renders the Scalar reference under the console's
 *    /docs CSP with no CSP violations or page errors; screenshots go to <outDir>.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:4600';
const outDir = process.argv[2] ?? '.tmp/docs-proof';
const insecure = process.argv.includes('--insecure');
if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
await mkdir(outDir, { recursive: true });

const report = { base: BASE, at: new Date().toISOString(), http: [], browser: {} };
const head = async (p, method = 'GET') => {
  const r = await fetch(new URL(p, BASE), { method, redirect: 'manual' });
  const body = method === 'GET' ? await r.text() : '';
  return {
    path: p,
    method,
    status: r.status,
    type: r.headers.get('content-type'),
    csp: r.headers.get('content-security-policy'),
    apiJson404: body.includes('"Route not found."'),
    bytes: body.length,
  };
};
for (const p of ['/docs', '/openapi.json', '/readyz']) report.http.push(await head(p), await head(p, 'HEAD'));
for (const p of ['/internal', '/internal/metrics', '/metrics', '/docs/anything', '/openapi.yaml', '/v10/events', '/server-only-probe'])
  report.http.push(await head(p));
// Read-only: other methods are answered by the console (405), never forwarded.
report.methods = [];
for (const p of ['/docs', '/openapi.json'])
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const r = await fetch(new URL(p, BASE), { method, body: ['POST', 'PUT', 'PATCH'].includes(method) ? '{"fixture":true}' : undefined });
    report.methods.push({ path: p, method, status: r.status, allow: r.headers.get('allow') });
  }
if (process.argv.includes('--echo')) {
  // The console points at a header-echo upstream: show which credentials reach the "API" per path.
  const credentials = { cookie: 'better-auth.session_token=fixture-session', authorization: 'Bearer lb_read_fixture' };
  report.echo = [];
  for (const p of ['/docs', '/openapi.json', '/api/echo-probe', '/v1/echo-probe']) {
    const seen = await (await fetch(new URL(p, BASE), { headers: credentials })).json();
    report.echo.push({
      path: p,
      upstreamMethod: seen.method,
      upstreamCookie: Boolean(seen.headers.cookie),
      upstreamAuthorization: Boolean(seen.headers.authorization),
    });
  }
  await writeFile(path.join(outDir, 'docs-proof.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
const doc = await (await fetch(new URL('/openapi.json', BASE))).json();
report.openapi = { title: doc.info?.title, servers: doc.servers, operations: Object.values(doc.paths ?? {}).flatMap(Object.keys).length };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: insecure });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`));
  const external = new Set();
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== new URL(BASE).origin) external.add(`${u.origin}${u.pathname}`);
  });
  const res = await page.goto(new URL('/docs', BASE).href, { waitUntil: 'networkidle' });
  await page.getByText('Logbird API', { exact: false }).first().waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.join(outDir, 'docs-1440.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(outDir, 'docs-390.png') });
  report.browser = {
    status: res?.status(),
    title: await page.title(),
    csp: res?.headers()['content-security-policy'],
    externalRequests: [...external],
    problems,
  };
} finally {
  await browser.close();
}
await writeFile(path.join(outDir, 'docs-proof.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
