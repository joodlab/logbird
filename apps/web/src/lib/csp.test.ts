import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCspManifest,
  cloudflareHeadersFor,
  cloudflarePath,
  headersFile,
  inlineScripts,
  pagePath,
  parseHeadersFile,
  scriptHash,
  scriptSources,
  verifyCsp,
  writeCsp,
} from './csp';
import { contentSecurityPolicy, DEV_CONTENT_SECURITY_POLICY, securityHeaders } from './security-headers';

// A fictional prerendered page: theme bootstrap, JSON-LD, hydration data, and an external module script.
const page = (data: string) =>
  `<!DOCTYPE html><html lang="en"><head><script>(function(){document.documentElement.classList.add('dark')})()</script>` +
  `<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"${data}"}</script></head>` +
  `<body><main>${data}</main><script class="$tsr">self.$_TSR={page:"${data}"};document.currentScript.remove()</script>` +
  '<script type="module" async="" src="/assets/index-abc123.js"></script></body></html>';

describe('inline script hashes', () => {
  it('hashes every inline script (JSON-LD included) and skips external ones', () => {
    const scripts = inlineScripts(page('Home'));
    expect(scripts).toHaveLength(3);
    expect(scripts[1]).toContain('"@type":"WebSite"');
    expect(scripts.some((script) => script.includes('index-abc123'))).toBe(false);
    expect(scriptHash('alert(1)')).toBe('sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI=');
    // Browsers hash the parsed text: CRLF is already LF, and NUL is U+FFFD (TanStack's hydration data has NULs).
    expect(scriptHash('a();\r\nb();')).toBe(scriptHash('a();\nb();'));
    expect(scriptHash('m={i:"__root__\0"}')).toBe(scriptHash('m={i:"__root__�"}'));
    expect(scriptHash('m={i:"__root__\0"}')).toBe('sha256-zlj3F3RSJ0Upfuoq71C+GOhYEErdtoNlH3T8QfWj6rw=');
  });

  it('maps files to the URLs each target serves them at', () => {
    expect(pagePath('index.html')).toBe('/');
    expect(pagePath('compare\\bemi\\index.html')).toBe('/compare/bemi');
    expect(pagePath('404.html')).toBe('/404');
    expect(cloudflarePath('index.html')).toBe('/');
    expect(cloudflarePath('compare/bemi/index.html')).toBe('/compare/bemi/');
    expect(cloudflarePath('404.html')).toBe('/404');
  });

  it('allows no inline script without a hash, except on the dev server', () => {
    expect(scriptSources(securityHeaders['Content-Security-Policy'])).toEqual(["'self'"]);
    expect(scriptSources(contentSecurityPolicy(['sha256-abc=']))).toEqual(["'self'", "'sha256-abc='"]);
    expect(contentSecurityPolicy()).toContain("style-src 'self' 'unsafe-inline'");
    expect(contentSecurityPolicy()).toContain("frame-ancestors 'none'");
    expect(scriptSources(DEV_CONTENT_SECURITY_POLICY)).toContain("'unsafe-inline'");
    // Two comma-joined policies are both enforced; the check refuses them.
    expect(scriptSources(`${contentSecurityPolicy()}, ${contentSecurityPolicy()}`)).toBeNull();
  });
});

describe('build output', () => {
  let output: string;
  const files = { 'index.html': page('Home'), 'about/index.html': page('About'), '404.html': page('Not found') };
  beforeEach(async () => {
    output = await mkdtemp(join(tmpdir(), 'logbird-web-csp-'));
    for (const [file, html] of Object.entries(files)) {
      await mkdir(dirname(join(output, 'public', file)), { recursive: true });
      await writeFile(join(output, 'public', file), html);
    }
  });
  afterEach(async () => {
    await rm(output, { recursive: true, force: true });
  });

  it('covers every inline script of every page, on Node and on Cloudflare', async () => {
    const summary = await writeCsp(output);
    expect(summary).toMatchObject({ pages: 3, rules: 5 });
    const manifest = JSON.parse(await readFile(join(output, 'csp.json'), 'utf8'));
    const rules = parseHeadersFile(await readFile(join(output, 'public', '_headers'), 'utf8'));
    for (const [file, html] of Object.entries(files)) {
      const node = scriptSources(contentSecurityPolicy(manifest.pages[pagePath(file)].scriptHashes));
      const cloudflare = scriptSources(cloudflareHeadersFor(rules, cloudflarePath(file)).get('content-security-policy'));
      for (const script of inlineScripts(html)) {
        expect(node).toContain(`'${scriptHash(script)}'`);
        expect(cloudflare).toContain(`'${scriptHash(script)}'`);
      }
      expect(cloudflare).not.toContain("'unsafe-inline'");
    }
    // Each page lists only its own hydration hash; Cloudflare's 404 page (any unknown path) gets the 404 policy.
    const about = cloudflareHeadersFor(rules, '/about/').get('content-security-policy') ?? '';
    expect(about).not.toContain(scriptHash(inlineScripts(files['index.html'])[2] ?? ''));
    expect(cloudflareHeadersFor(rules, '/missing').get('content-security-policy')).toBe(contentSecurityPolicy(manifest.pages['/404'].scriptHashes));
    // The other headers still apply everywhere.
    expect(cloudflareHeadersFor(rules, '/about/').get('x-content-type-options')).toBe('nosniff');
    expect(cloudflareHeadersFor(rules, '/assets/index-abc123.js').get('cache-control')).toContain('immutable');
  });

  it('fails when a page changes after hashing, or a page rule stops detaching the catch-all policy', async () => {
    const manifest = await buildCspManifest(join(output, 'public'));
    const headers = headersFile(manifest);
    await writeFile(join(output, 'public', 'about/index.html'), page('About, edited after the build'));
    const drift = await verifyCsp(join(output, 'public'), manifest, headers);
    expect(drift.filter((problem) => problem.startsWith('about/index.html (node)'))).toHaveLength(2);
    expect(drift.filter((problem) => problem.startsWith('about/index.html (cloudflare)'))).toHaveLength(2);
    await writeFile(join(output, 'public', 'about/index.html'), files['about/index.html']);
    // Without `! Content-Security-Policy`, Cloudflare joins both policies and the page's hashes no longer suffice.
    const merged = await verifyCsp(join(output, 'public'), manifest, headers.replaceAll('  ! Content-Security-Policy\n', ''));
    expect(merged.some((problem) => problem.includes('no single script-src policy'))).toBe(true);
    await expect(writeCsp(join(output, 'missing'))).rejects.toThrow();
  });

  it('matches the deploy configuration it assumes', async () => {
    // cloudflarePath() follows auto-trailing-slash, and the catch-all policy relies on 404.html for unknown paths.
    const wrangler = (await readFile('wrangler.jsonc', 'utf8')).replace(/^\s*\/\/.*$/gm, '');
    expect(wrangler).toMatch(/"html_handling":\s*"auto-trailing-slash"/);
    expect(wrangler).toMatch(/"not_found_handling":\s*"404-page"/);
    expect(JSON.parse(await readFile('package.json', 'utf8')).scripts.build).toMatch(/&& tsx scripts\/csp\.ts$/);
  });
});
