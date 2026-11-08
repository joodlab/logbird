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
});
