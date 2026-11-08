import { inlineScripts, scriptHash, scriptSources } from '../src/lib/csp';
import { securityHeaders } from '../src/lib/security-headers';
import { prerenderPaths } from '../src/lib/site-map';

/**
 * Checks a running site the way a browser sees it: every page and a set of unknown, dotted, escaped and API paths.
 * Each HTML response must carry one Content-Security-Policy without 'unsafe-inline' whose script hashes cover every
 * inline script in that very body, plus the other security headers; unknown paths must be the 404 page with status
 * 404, except the one documented redirect (Cloudflare's asset router decodes `%2F` and redirects
 * `/x%2f..%2fabout%2findex.html` to `/about/`, where the Node server answers 404; either is a static page with its own
 * policy); unknown /api/* paths must answer JSON. Use it against `pnpm start`, `pnpm serve:static`, `wrangler dev` and a
 * deploy, so a target that renders pages on demand (fresh, unhashed inline scripts) fails here, not in a browser.
 *
 * POST to a page path must be a 405 on every target.
 *
 *   BASE_URL=http://127.0.0.1:4620 [NO_API=1] tsx scripts/check-live.ts
 *
 * NO_API=1 skips the API checks (serve-static has no /api).
 */
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4620';
const unknown = [
  '/no-such-page',
  '/product/no-such-page',
  '/compare/bemi/no-such-page',
  '/foo.bar',
  '/x.js',
  '/blog/no-such-post.md',
  '/assets/missing.js',
  '/x%2f..%2fabout%2findex.html',
  '/api',
  '/_headers',
  // Case variants of real files and pages: hosts with case-insensitive file systems must not serve or render them.
  '/ROBOTS.TXT',
  '/Sitemap.xml',
  '/Brand/logbird-favicon.svg',
  '/About/index.html',
  '/ABOUT',
];
/**
 * The only unknown path allowed to redirect, and where to: Cloudflare's asset router decodes `%2F` and sends this one to
 * the static About page (with its own policy). Every other unknown path must stay a 404, so a host that redirects
 * missing pages to a real page fails.
 */
const DOCUMENTED_REDIRECTS: Record<string, string> = { '/x%2f..%2fabout%2findex.html': '/about' };
const api = process.env.NO_API === '1' ? [] : ['/api/no-such-endpoint', '/api/waitlist/x'];
const problems: string[] = [];
const rows: Record<string, string | number>[] = [];

async function checkHtml(path: string, expected: number) {
  let expectedStatus = expected;
  const response = await fetch(new URL(path, base), { redirect: 'follow' });
  const body = await response.text();
  const policy = response.headers.get('content-security-policy') ?? undefined;
  const sources = scriptSources(policy);
  const scripts = inlineScripts(body);
  const missing = sources ? scripts.filter((script) => !sources.includes(`'${scriptHash(script)}'`)).length : scripts.length;
  const fail = (problem: string) => problems.push(`${path}: ${problem}`);
  const landed = new URL(response.url).pathname.replace(/\/$/, '') || '/';
  if (expectedStatus === 404 && response.redirected) {
    if (DOCUMENTED_REDIRECTS[path] === landed) {
      expectedStatus = 200;
    } else {
      fail(`redirected to ${response.url.replace(base, '')}; only ${Object.keys(DOCUMENTED_REDIRECTS).join(', ')} may redirect`);
    }
  }
  if (response.status !== expectedStatus) {
    fail(`status ${response.status}, expected ${expectedStatus}`);
  }
  if (!response.headers.get('content-type')?.startsWith('text/html')) {
    fail(`content-type ${response.headers.get('content-type')}`);
  }
  if (!sources) {
    fail(`no single script-src policy (${policy ?? 'none'})`);
  } else if (sources.includes("'unsafe-inline'")) {
    fail("script-src allows 'unsafe-inline'");
  }
  if (missing) {
    fail(`${missing} of ${scripts.length} inline scripts not covered by the policy`);
  }
  if (expectedStatus === 404 && !body.includes('No event at this address.')) {
    fail('not the 404 page');
  }
  for (const [name, value] of Object.entries(securityHeaders)) {
    if (name !== 'Content-Security-Policy' && response.headers.get(name) !== value) {
      fail(`${name}: ${response.headers.get(name) ?? 'missing'}`);
    }
  }
  rows.push({ path, status: response.status, inline: scripts.length, uncovered: missing, url: response.url.replace(base, '') });
}

for (const path of prerenderPaths) {
  await checkHtml(path, 200);
}
for (const path of unknown) {
  await checkHtml(path, 404);
}
for (const path of api) {
  const response = await fetch(new URL(path, base));
  const type = response.headers.get('content-type') ?? '';
  if (response.status !== 404 || !type.startsWith('application/json')) {
    problems.push(`${path}: API answered ${response.status} ${type}, expected a JSON 404`);
  }
  rows.push({ path, status: response.status, inline: '-', uncovered: '-', url: type });
}
// Pages are static on every target: another method than GET/HEAD outside /api/ is a 405 and never a rendered page.
// Node and serve-static answer it themselves (with Allow: GET, HEAD); Cloudflare's asset router answers 405 with an
// empty body before the Worker (server/method-guard.ts is the Worker's own guard if that ever changes).
for (const path of ['/about/', '/no-such-page']) {
  const response = await fetch(new URL(path, base), { method: 'POST', redirect: 'manual' });
  const body = await response.text();
  if (response.status !== 405 || /<script|<html/i.test(body)) {
    problems.push(`POST ${path}: ${response.status} with ${body.length} bytes, expected an empty 405`);
  }
  rows.push({ path: `POST ${path}`, status: response.status, inline: '-', uncovered: '-', url: `allow: ${response.headers.get('allow') ?? '-'}, ${body.length} bytes` });
}
console.table(rows);
if (problems.length) {
  console.error(`check-live: ${problems.length} problems at ${base}:\n${problems.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`check-live: ${rows.length} responses at ${base}; every HTML response's policy covers its own inline scripts.`);
}
