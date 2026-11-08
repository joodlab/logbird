import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { apiReferenceBundle, apiReferencePage } from './api-reference';

describe('GET /docs', () => {
  const app = new Hono().get('/docs', apiReferencePage);

  it('loads only the pinned, integrity-checked reference bundle', async () => {
    const response = await app.request('/docs');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(apiReferenceBundle.src).toMatch(/@\d+\.\d+\.\d+\//);
    expect(html).toContain(`<script src="${apiReferenceBundle.src}" integrity="${apiReferenceBundle.integrity}" crossorigin="anonymous"></script>`);
    // No module build, moving `latest` URL or any other external script.
    expect(html.match(/<script\b[^>]*\bsrc=/g)).toHaveLength(1);
    expect(html).not.toContain('type="module"');
    expect(html).not.toContain('cdn.jsdelivr.net/npm/@scalar/api-reference/');
  });

  it('points at the same-origin document and turns off third-party features', async () => {
    const html = await (await app.request('/docs')).text();
    expect(html).toContain('"url": "/openapi.json"');
    expect(html).toContain('"withDefaultFonts": false');
    expect(html).toContain('"telemetry": false');
    expect(html).toMatch(/"agent": \{\s*"disabled": true\s*\}/);
  });

  it("matches the console's /docs CSP (exact bundle URL and inline-script hash)", async () => {
    const html = await (await app.request('/docs')).text();
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
    expect(inline).toHaveLength(1);
    const hash = `'sha256-${createHash('sha256')
      .update(inline[0] ?? '')
      .digest('base64')}'`;
    // The console (apps/app) owns the header; load its actual policy and compare the parsed script-src.
    const { apiReferenceContentSecurityPolicy: policy } = (await import(new URL('../../app/server/proxy-paths.ts', import.meta.url).href)) as {
      apiReferenceContentSecurityPolicy: string;
    };
    const directives = new Map(
      policy
        .split(';')
        .map((d) => d.trim().split(/\s+/))
        .filter((tokens) => tokens[0])
        .map(([name, ...values]) => [name?.toLowerCase(), values] as const),
    );
    expect(new Set(directives.get('script-src'))).toEqual(new Set([apiReferenceBundle.src, hash]));
    expect(directives.get('connect-src')).toEqual(["'self'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
  });
});
