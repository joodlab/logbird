import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { siteConfigFrom } from '../src/env';
import { writeCsp } from '../src/lib/csp';
import { releaseBlockers } from '../src/lib/release';
import { loadPublicEnv } from './public-env';

// Resolve the public WEB_* values once (scripts/public-env.ts: root .env*, then apps/web .env*, then the process env)
// and hand the same values to the release gate and to both build phases. No phase reloads a .env file itself: a
// dotenv preload would put root values into process.env, where they would outrank apps/web's .env files.
const publicEnv = Object.fromEntries(Object.entries(loadPublicEnv()).filter((entry): entry is [string, string] => entry[1] !== undefined));
// A Cloudflare build is a public build: refuse while any release blocker remains (release.ts).
const blockers = releaseBlockers(siteConfigFrom(publicEnv));
if (blockers.length && process.env.LOGBIRD_WEB_ALLOW_INTERIM !== '1') {
  throw new Error(
    `Refusing to package a public build: ${blockers.join('; ')}. Resolve them (see src/lib/release.ts), or set LOGBIRD_WEB_ALLOW_INTERIM=1 for a local preview only.`,
  );
}
const pnpm = process.env.npm_execpath ?? '';
if (!pnpm) {
  throw new Error('Run this script through pnpm build:cloudflare.');
}
function phaseEnv(preset: 'node-server' | 'cloudflare-module', staticReady: string): NodeJS.ProcessEnv {
  return { ...process.env, ...publicEnv, NITRO_PRESET: preset, LOGBIRD_WEB_STATIC_READY: staticReady };
}
async function run(args: string[], env: NodeJS.ProcessEnv) {
  await new Promise<void>((done, reject) => {
    // Corepack exposes a JS entry; pnpm's Windows standalone installation exposes an EXE.
    const standalone = pnpm.toLowerCase().endsWith('.exe');
    const child = spawn(standalone ? pnpm : process.execPath, [...(standalone ? [] : [pnpm]), ...args], {
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? done() : reject(new Error(`Build phase failed (${code ?? 'signal'}).`))));
  });
}

// Nitro's Worker preview requires Wrangler. Prerender with the Node adapter instead,
// then verify that the Worker client build can serve every referenced hashed asset.
await run(['run', 'build'], phaseEnv('node-server', ''));
const publicDir = resolve('.output/public');
await mkdir('.tmp', { recursive: true });
const snapshot = await mkdtemp(resolve('.tmp/cloudflare-html-'));
const pages = (await readdir(publicDir, { recursive: true })).filter((path) => path.endsWith('.html'));
if (!pages.includes('index.html') || !pages.includes('404.html')) {
  throw new Error('Node prerender output is incomplete.');
}
const assets = new Set<string>();
for (const page of pages) {
  const html = await readFile(resolve(publicDir, page), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="(\/site-assets\/[^"?]+)"/g)) {
    if (match[1]) {
      assets.add(match[1].slice(1));
    }
  }
  const target = resolve(snapshot, page);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(publicDir, page), target);
}
await run(['exec', 'vite', 'build'], phaseEnv('cloudflare-module', '1'));
for (const asset of assets) {
  await access(resolve(publicDir, asset)).catch(() => {
    throw new Error(`Client output changed between adapters: ${asset}. Refusing to publish stale prerendered HTML.`);
  });
}
for (const page of pages) {
  const target = resolve(publicDir, page);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(snapshot, page), target);
}
// The Worker build replaced .output/public; hash the restored HTML and write the per-page _headers last.
const csp = await writeCsp(resolve('.output'));
console.log(`Packaged Cloudflare Worker with ${pages.length} Node-prerendered HTML files; all referenced assets verified.`);
console.log(`csp: ${csp.pages} pages covered by per-page script hashes; _headers ${csp.rules} rules, longest line ${csp.longestLine} chars.`);
