/**
 * Public, client-safe site configuration. This is the ONLY file that may contain the provisional domain (pending the
 * owner: the domain is not bought yet); a test enforces it. Server-only settings live in src/server/env.ts.
 *
 * The site's variables are prefixed `WEB_` so they never collide with the console's (`APP_URL` in the root .env is the
 * local console). Values come from the build (`__SITE_ENV__`, injected by vite.config.ts) or from process.env in Node
 * scripts and tests.
 *
 *   WEB_SITE_URL       canonical origin of this site               default https://<provisional domain>
 *   WEB_APP_URL        console sign-in URL; unset hides "Sign in"   default unset (Cloud is waitlist-only)
 *   WEB_GITHUB_PUBLIC  "true" once the repository is public        default false
 *   WEB_GITHUB_URL     repository URL; required when public        default unset
 *   WEB_ORG_NAME       legal name for © and JSON-LD (pending owner) default unset → "Logbird contributors", no Organization
 */
/** The only variables the build passes to the site (vite.config.ts) and that Turbo hashes (turbo.json). */
export const PUBLIC_ENV_KEYS = ['WEB_SITE_URL', 'WEB_APP_URL', 'WEB_GITHUB_URL', 'WEB_GITHUB_PUBLIC', 'WEB_ORG_NAME'] as const;

declare const __SITE_ENV__: Record<string, string | undefined> | undefined;

const source: Record<string, string | undefined> =
  typeof __SITE_ENV__ === 'undefined' ? (typeof process === 'undefined' ? {} : process.env) : __SITE_ENV__;

const DOMAIN = 'logbird.dev';

export interface SiteConfig {
  SITE_URL: string;
  /** Undefined while Cloud is waitlist-only: the header shows no "Sign in" link. */
  APP_URL?: string;
  GITHUB_PUBLIC: boolean;
  GITHUB_URL?: string;
  /** The publisher's legal name is pending the owner; until it is set the site names no company. */
  ORG_NAME?: string;
}

/**
 * Builds the public configuration from WEB_* values. The bundle (via __SITE_ENV__), discovery files and OG cards all
 * call this with the same resolved values (scripts/public-env.ts), so their origins always agree.
 */
export function siteConfigFrom(values: Record<string, string | undefined>): SiteConfig {
  const url = (name: string, fallback?: string): string | undefined => {
    const value = values[name]?.trim();
    if (!value) {
      return fallback;
    }
    try {
      return new URL(value).href.replace(/\/$/, '');
    } catch {
      throw new Error(`${name} must be an absolute URL.`);
    }
  };
  const config: SiteConfig = {
    SITE_URL: url('WEB_SITE_URL', `https://${DOMAIN}`) as string,
    APP_URL: url('WEB_APP_URL'),
    GITHUB_PUBLIC: values.WEB_GITHUB_PUBLIC === 'true',
    GITHUB_URL: url('WEB_GITHUB_URL'),
    ORG_NAME: values.WEB_ORG_NAME?.trim() || undefined,
  };
  if (config.GITHUB_PUBLIC && !config.GITHUB_URL) {
    throw new Error('WEB_GITHUB_PUBLIC=true needs WEB_GITHUB_URL.');
  }
  return config;
}

export const siteConfig = siteConfigFrom(source);
export const { SITE_URL, APP_URL, GITHUB_PUBLIC, GITHUB_URL, ORG_NAME } = siteConfig;
export const COPYRIGHT_HOLDER = ORG_NAME ?? 'Logbird contributors';

/** Pending-domain mailboxes. Owner question: confirm these once the domain is bought. */
export const CONTACT_EMAIL = `hello@${DOMAIN}`;
export const SECURITY_EMAIL = `security@${DOMAIN}`;
export const PRIVACY_EMAIL = `privacy@${DOMAIN}`;

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;
/** Public URLs that would point visitors at a developer machine. A Cloudflare (public) build must have none. */
export function localPublicUrls(
  values: Record<string, string | undefined> = { WEB_SITE_URL: SITE_URL, WEB_APP_URL: APP_URL, WEB_GITHUB_URL: GITHUB_URL },
) {
  return Object.entries(values)
    .filter(([key, value]) => key.endsWith('_URL') && value && LOCAL.test(new URL(value).hostname))
    .map(([key]) => key);
}
