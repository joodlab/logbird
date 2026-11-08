import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ASSET_CACHE, contentSecurityPolicy, MEDIA_CACHE, securityHeaders } from './security-headers';

/**
 * Build-time script hashes for the Content-Security-Policy (Node only: scripts/csp.ts, build-cloudflare.ts, tests).
 *
 * Every page is prerendered, and its inline scripts (theme bootstrap, JSON-LD, TanStack Start's hydration data, which
 * changes with every build) are fixed once the HTML is written. So after the build we hash each page's inline scripts
 * and serve each page a policy that lists exactly those hashes:
 *
 * - `.output/csp.json`: the manifest the Node server (server/static-pages.ts) and scripts/serve-static.ts read;
 * - `.output/public/_headers`: Cloudflare's per-path rules.
 *
 * verifyCsp() then re-reads the final HTML and fails the build if any inline script isn't covered by the policy each
 * target will actually serve, so the hashes can't drift from the pages.
 */
export interface CspManifest {
  /** URL path (no trailing slash; `/` for the home page, `/404` for the not-found page) → its HTML file and hashes. */
  pages: Record<string, { file: string; scriptHashes: string[] }>;
}

export const CSP_MANIFEST_FILE = 'csp.json';
export const NOT_FOUND_PAGE = '/404';
/** Cloudflare's documented limits for `_headers`. */
export const HEADERS_LIMITS = { rules: 100, lineLength: 2000 } as const;

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
/** The text of every inline `<script>` (any type, including JSON-LD), in document order. External scripts are skipped. */
export function inlineScripts(html: string): string[] {
  return [...html.matchAll(SCRIPT)].filter((match) => !/\ssrc\s*=/i.test(match[1] ?? '')).map((match) => match[2] ?? '');
}

/**
 * The text the browser hashes: what the HTML parser leaves of the raw script source. It turns CRLF and CR into LF, and
 * replaces U+0000 with U+FFFD (TanStack Start's hydration data contains NUL characters in its match IDs).
 */
export const parsedScriptText = (raw: string) => raw.replace(/\r\n?/g, '\n').replaceAll('\0', '�');
/** CSP hash source of an inline script, from its raw source in the HTML. */
export const scriptHash = (raw: string) => `sha256-${createHash('sha256').update(parsedScriptText(raw), 'utf8').digest('base64')}`;

/** `about/index.html` → `/about`, `index.html` → `/`, `404.html` → `/404`. */
export function pagePath(file: string) {
  const path = `/${file.replaceAll('\\', '/')}`.replace(/(?:\/index)?\.html$/, '');
  return path || '/';
}

/**
 * The URL Cloudflare serves a page's HTML at, under wrangler.jsonc's `html_handling: "auto-trailing-slash"`:
 * `about/index.html` at `/about/` (`/about` redirects there), `404.html` at `/404`.
 */
export function cloudflarePath(file: string) {
  const normalized = file.replaceAll('\\', '/');
  if (normalized === 'index.html') {
    return '/';
  }
  return normalized.endsWith('/index.html') ? `/${normalized.slice(0, -'index.html'.length)}` : `/${normalized.replace(/\.html$/, '')}`;
}

async function htmlFiles(publicDir: string) {
  return (await readdir(publicDir, { recursive: true }))
    .map((file) => String(file).replaceAll('\\', '/'))
    .filter((file) => file.endsWith('.html'))
    .sort();
}

export async function buildCspManifest(publicDir: string): Promise<CspManifest> {
  const pages: CspManifest['pages'] = {};
  for (const file of await htmlFiles(publicDir)) {
    const html = await readFile(resolve(publicDir, file), 'utf8');
    pages[pagePath(file)] = { file, scriptHashes: [...new Set(inlineScripts(html).map(scriptHash))] };
  }
  if (!pages[NOT_FOUND_PAGE]) {
    throw new Error(`csp: no ${NOT_FOUND_PAGE}.html in ${publicDir}. Run the build first.`);
  }
  return { pages };
}

/** The policy one page is served with. */
export const pagePolicy = (manifest: CspManifest, path: string) => {
  const page = manifest.pages[path];
  if (!page) {
    throw new Error(`csp: no prerendered page for ${path}`);
  }
  return contentSecurityPolicy(page.scriptHashes);
};

/**
 * Cloudflare `_headers`. Rules apply in file order; a header set by two rules is comma-joined (two policies, both
 * enforced), so each page rule first detaches the catch-all CSP (`! Content-Security-Policy`) and then sets its own.
 * The catch-all carries the not-found page's policy: Cloudflare serves 404.html for unknown paths under `/*`.
 */
export function headersFile(manifest: CspManifest) {
  const block = (pattern: string, lines: string[]) => `${pattern}\n${lines.map((line) => `  ${line}`).join('\n')}\n`;
  const fallback = { ...securityHeaders, 'Content-Security-Policy': pagePolicy(manifest, NOT_FOUND_PAGE) };
  return [
    block(
      '/*',
      Object.entries(fallback).map(([key, value]) => `${key}: ${value}`),
    ),
    block('/assets/*', [`Cache-Control: ${ASSET_CACHE}`]),
    block('/media/*', [`Cache-Control: ${MEDIA_CACHE}`]),
    ...Object.entries(manifest.pages)
      .filter(([path]) => path !== NOT_FOUND_PAGE)
      .map(([path, page]) =>
        block(cloudflarePath(page.file), ['! Content-Security-Policy', `Content-Security-Policy: ${pagePolicy(manifest, path)}`]),
      ),
  ].join('');
}

interface HeaderRule {
  pattern: string;
  set: [string, string][];
  unset: string[];
}
export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) {
      continue;
    }
    if (!/^\s/.test(line)) {
      rules.push({ pattern: line.trim(), set: [], unset: [] });
      continue;
    }
    const rule = rules.at(-1);
    if (!rule) {
      throw new Error(`_headers: header line before any path: ${line}`);
    }
    const entry = line.trim();
    if (entry.startsWith('! ')) {
      rule.unset.push(entry.slice(2).trim());
    } else {
      const colon = entry.indexOf(':');
      rule.set.push([entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()]);
    }
  }
  return rules;
}

/**
 * The headers Cloudflare's asset worker attaches to a path, following its implementation (workers-sdk
 * asset-worker `attachCustomHeaders`): matching rules in file order; `!` deletes; the first set of a header replaces,
 * later sets of the same header append with ", ".
 */
export function cloudflareHeadersFor(rules: HeaderRule[], path: string) {
  const headers = new Map<string, string>();
  const seen = new Set<string>();
  for (const rule of rules) {
    const matches = rule.pattern.endsWith('*') ? path.startsWith(rule.pattern.slice(0, -1)) : path === rule.pattern;
    if (!matches) {
      continue;
    }
    for (const key of rule.unset) {
      headers.delete(key.toLowerCase());
    }
    for (const [key, value] of rule.set) {
      const name = key.toLowerCase();
      const current = headers.get(name);
      headers.set(name, seen.has(name) && current !== undefined ? `${current}, ${value}` : value);
      seen.add(name);
    }
  }
  return headers;
}

/** The `script-src` sources of a policy, or null when there is none or the value holds more than one policy. */
export function scriptSources(policy: string | undefined) {
  if (!policy || policy.includes(',')) {
    return null;
  }
  const directive = policy
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([name]) => name === 'script-src');
  return directive ? directive.slice(1) : null;
}

/**
 * Checks the final HTML against what each target serves: every inline script's hash is in the page's policy for the
 * Node manifest and for Cloudflare's `_headers` (including the 404 page at an unknown path), no policy allows
 * `'unsafe-inline'` scripts, and `_headers` is within Cloudflare's limits. Returns the problems found.
 */
export async function verifyCsp(publicDir: string, manifest: CspManifest, headers: string): Promise<string[]> {
  const problems: string[] = [];
  const rules = parseHeadersFile(headers);
  if (rules.length > HEADERS_LIMITS.rules) {
    problems.push(`_headers has ${rules.length} rules; Cloudflare allows ${HEADERS_LIMITS.rules}.`);
  }
  const longest = Math.max(...headers.split('\n').map((line) => line.length));
  if (longest > HEADERS_LIMITS.lineLength) {
    problems.push(`_headers has a ${longest}-character line; Cloudflare allows ${HEADERS_LIMITS.lineLength}.`);
  }
  const files = await htmlFiles(publicDir);
  if (files.length !== Object.keys(manifest.pages).length) {
    problems.push(`${files.length} HTML files but ${Object.keys(manifest.pages).length} manifest entries.`);
  }
  for (const file of files) {
    const path = pagePath(file);
    const hashes = inlineScripts(await readFile(resolve(publicDir, file), 'utf8')).map(scriptHash);
    const targets: [string, string | undefined][] = [
      ['node', manifest.pages[path] ? pagePolicy(manifest, path) : undefined],
      ['cloudflare', cloudflareHeadersFor(rules, cloudflarePath(file)).get('content-security-policy')],
    ];
    if (path === NOT_FOUND_PAGE) {
      targets.push(['cloudflare (unknown path)', cloudflareHeadersFor(rules, '/no-such-page-csp-check').get('content-security-policy')]);
    }
    for (const [target, policy] of targets) {
      const sources = scriptSources(policy);
      if (!sources) {
        problems.push(`${file} (${target}): no single script-src policy (${policy ?? 'none'}).`);
        continue;
      }
      if (sources.includes("'unsafe-inline'")) {
        problems.push(`${file} (${target}): script-src allows 'unsafe-inline'.`);
      }
      for (const hash of hashes) {
        if (!sources.includes(`'${hash}'`)) {
          problems.push(`${file} (${target}): inline script ${hash} is not in the policy.`);
        }
      }
    }
  }
  return problems;
}

/** Writes the manifest and `_headers` for a finished build in `outputDir` (`.output`), verifies them, and summarises. */
export async function writeCsp(outputDir: string) {
  const publicDir = resolve(outputDir, 'public');
  const manifest = await buildCspManifest(publicDir);
  const headers = headersFile(manifest);
  await writeFile(resolve(outputDir, CSP_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(resolve(publicDir, '_headers'), headers);
  const problems = await verifyCsp(publicDir, manifest, headers);
  if (problems.length) {
    throw new Error(`csp: the policy doesn't cover the built pages:\n${problems.join('\n')}`);
  }
  const hashes = new Set(Object.values(manifest.pages).flatMap((page) => page.scriptHashes));
  return {
    pages: Object.keys(manifest.pages).length,
    hashes: hashes.size,
    rules: parseHeadersFile(headers).length,
    longestLine: Math.max(...headers.split('\n').map((line) => line.length)),
    manifestFile: resolve(outputDir, CSP_MANIFEST_FILE),
    headersFile: resolve(dirname(publicDir), 'public', '_headers'),
  };
}
