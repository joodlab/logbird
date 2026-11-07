import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { PUBLIC_ENV_KEYS } from '../src/env';

const webDir = fileURLToPath(new URL('..', import.meta.url));
/**
 * The public WEB_* values for a build, resolved once in one order: the root .env files, then apps/web's .env files,
 * then the process environment (highest). vite.config.ts and scripts/og.ts both call this, so the bundle, sitemap,
 * robots.txt, llms.txt and OG cards always see the same origin. Vite's loadEnv doesn't write to process.env, which is
 * why consumers must take these values rather than read process.env.
 */
export function loadPublicEnv(mode = 'production'): Record<string, string | undefined> {
  const loaded: Record<string, string | undefined> = { ...loadEnv(mode, resolve(webDir, '../..'), ''), ...loadEnv(mode, webDir, ''), ...process.env };
  return Object.fromEntries(PUBLIC_ENV_KEYS.map((key) => [key, loaded[key]]));
}
