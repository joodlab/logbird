import { apiReference } from '@scalar/hono-api-reference';
import type { Context } from 'hono';

/**
 * The API reference UI bundle. The console proxies `/docs` on the public origin (#61), so this script runs beside the
 * console's session: it is pinned to an exact version and integrity-checked rather than following jsDelivr's moving
 * `latest`. To upgrade, download the new `dist/browser/standalone.js`, check it, and replace both values:
 * `curl -sS <src> | openssl dgst -sha384 -binary | openssl base64 -A`.
 */
export const apiReferenceBundle = {
  src: 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.0/dist/browser/standalone.js',
  integrity: 'sha384-oH1C0RwqcwbVXkC+r8A+4qRoyEUQdtxAzOwumkxZtQBBcsy61FOoPt7B50OVJYYQ',
} as const;

const render = apiReference({
  url: '/openapi.json',
  pageTitle: 'Logbird API reference',
  cdn: apiReferenceBundle.src,
  // Self-contained page: no third-party fonts, telemetry or hosted AI agent. The console CSP also limits it to 'self'.
  withDefaultFonts: false,
  telemetry: false,
  agent: { disabled: true },
  showDeveloperTools: 'never',
});

/** `GET /docs`: Scalar's page with Subresource Integrity on the pinned bundle. */
export async function apiReferencePage(c: Context) {
  const response = (await render(c, async () => undefined)) as Response;
  const tag = `<script src="${apiReferenceBundle.src}"`;
  const html = await response.text();
  if (!html.includes(tag)) throw new Error('API reference bundle tag not found');
  return c.html(html.replace(tag, `${tag} integrity="${apiReferenceBundle.integrity}" crossorigin="anonymous"`));
}
