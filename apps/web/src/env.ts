/**
 * Public, client-safe site configuration. This is the ONLY file that may contain the provisional domain
 * (pending owner decision: the domain is not bought yet). Server-only settings live in src/server/env.ts.
 *
 * Values come from the build (`__SITE_ENV__`, injected by vite.config.ts from SITE_URL, APP_URL, GITHUB_URL,
 * GITHUB_PUBLIC) or from process.env in Node scripts and tests.
 */
declare const __SITE_ENV__: Record<string, string | undefined> | undefined;

const source: Record<string, string | undefined> =
  typeof __SITE_ENV__ === 'undefined' ? (typeof process === 'undefined' ? {} : process.env) : __SITE_ENV__;

const DOMAIN = 'logbird.dev';

function url(name: string, fallback: string): string {
  const value = source[name]?.trim();
  if (!value) {
    return fallback;
  }
  try {
    return new URL(value).href.replace(/\/$/, '');
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
}

export const SITE_URL = url('SITE_URL', `https://${DOMAIN}`);
export const APP_URL = url('APP_URL', `https://app.${DOMAIN}`);
export const GITHUB_URL = url('GITHUB_URL', 'https://github.com/joodlab/logbird');
export const GITHUB_PUBLIC = source.GITHUB_PUBLIC === 'true';

/** Pending-domain mailboxes. Owner question: confirm these once the domain is bought. */
export const CONTACT_EMAIL = `hello@${DOMAIN}`;
export const SECURITY_EMAIL = `security@${DOMAIN}`;
export const PRIVACY_EMAIL = `privacy@${DOMAIN}`;
