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
 *   WEB_SECURITY_EMAIL vulnerability-report mailbox; NO default     unset → SECURITY.md's "request a private channel" wording
 *   WEB_CONTACT_EMAIL  general contact mailbox; NO default          unset → "use the form" wording
 *   WEB_PRIVACY_EMAIL  privacy-request mailbox; NO default          unset → the form's "A privacy request" topic (blocker)
 *   WEB_LEGAL_ADDRESS  the operator's postal address (legal pages)  unset → no address shown (pending owner)
 *   WEB_GOVERNING_LAW  e.g. "the laws of <country>" (terms)          unset → neutral wording (pending owner)
 *   WEB_HOSTING_PROVIDER  server provider and region (privacy)      unset → "our server provider" (pending owner)
 *   WEB_EMAIL_PROVIDER    email delivery provider (privacy)          unset → Postmark, Logbird Cloud's provider
 */
/** The only variables the build passes to the site (vite.config.ts) and that Turbo hashes (turbo.json). */
export const PUBLIC_ENV_KEYS = [
  'WEB_SITE_URL',
  'WEB_APP_URL',
  'WEB_GITHUB_URL',
  'WEB_GITHUB_PUBLIC',
  'WEB_ORG_NAME',
  'WEB_SECURITY_EMAIL',
  'WEB_CONTACT_EMAIL',
  'WEB_PRIVACY_EMAIL',
  'WEB_LEGAL_ADDRESS',
  'WEB_GOVERNING_LAW',
  'WEB_HOSTING_PROVIDER',
  'WEB_EMAIL_PROVIDER',
] as const;

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
  /**
   * Where researchers report vulnerabilities. No default: a guessed mailbox on a domain we don't control would send
   * reports nowhere, or to a stranger. Unset renders SECURITY.md's wording and is a release blocker (release.ts).
   */
  SECURITY_EMAIL?: string;
  /** General contact mailbox. No default, for the same reason; unset renders "use the form" wording (release blocker). */
  CONTACT_EMAIL?: string;
  /**
   * Where people send privacy requests (access, correction, deletion). No default; unset, the privacy policy points to
   * the contact form's "A privacy request" topic, which reaches the same team (release blocker until set).
   */
  PRIVACY_EMAIL?: string;
  /** The operator's postal address for the legal pages (pending owner); unset, no address is printed. */
  LEGAL_ADDRESS?: string;
  /** The governing-law clause of the terms, e.g. "the laws of <country>" (pending owner). */
  GOVERNING_LAW?: string;
  /** The server provider and region named in the privacy policy (pending owner), e.g. "<provider> (<country>)". */
  HOSTING_PROVIDER?: string;
  /** The email delivery provider named in the privacy policy; unset, Logbird Cloud's provider (Postmark). */
  EMAIL_PROVIDER?: string;
  /** False while WEB_SITE_URL is unset, i.e. the canonical origin is the provisional domain (a release blocker). */
  SITE_URL_CONFIGURED: boolean;
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
    SECURITY_EMAIL: values.WEB_SECURITY_EMAIL?.trim() || undefined,
    CONTACT_EMAIL: values.WEB_CONTACT_EMAIL?.trim() || undefined,
    PRIVACY_EMAIL: values.WEB_PRIVACY_EMAIL?.trim() || undefined,
    LEGAL_ADDRESS: values.WEB_LEGAL_ADDRESS?.trim() || undefined,
    GOVERNING_LAW: values.WEB_GOVERNING_LAW?.trim() || undefined,
    HOSTING_PROVIDER: values.WEB_HOSTING_PROVIDER?.trim() || undefined,
    EMAIL_PROVIDER: values.WEB_EMAIL_PROVIDER?.trim() || undefined,
    SITE_URL_CONFIGURED: Boolean(values.WEB_SITE_URL?.trim()),
  };
  for (const [key, value] of [
    ['WEB_SECURITY_EMAIL', config.SECURITY_EMAIL],
    ['WEB_CONTACT_EMAIL', config.CONTACT_EMAIL],
    ['WEB_PRIVACY_EMAIL', config.PRIVACY_EMAIL],
  ] as const) {
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new Error(`${key} must be an email address.`);
    }
  }
  if (config.GITHUB_PUBLIC && !config.GITHUB_URL) {
    throw new Error('WEB_GITHUB_PUBLIC=true needs WEB_GITHUB_URL.');
  }
  return config;
}

export const siteConfig = siteConfigFrom(source);
export const {
  SITE_URL,
  APP_URL,
  GITHUB_PUBLIC,
  GITHUB_URL,
  ORG_NAME,
  SECURITY_EMAIL,
  CONTACT_EMAIL,
  PRIVACY_EMAIL,
  LEGAL_ADDRESS,
  GOVERNING_LAW,
  HOSTING_PROVIDER,
  EMAIL_PROVIDER,
} = siteConfig;
export const COPYRIGHT_HOLDER = ORG_NAME ?? 'Logbird contributors';

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;
/** Public URLs that would point visitors at a developer machine. A Cloudflare (public) build must have none. */
export function localPublicUrls(
  values: Record<string, string | undefined> = { WEB_SITE_URL: SITE_URL, WEB_APP_URL: APP_URL, WEB_GITHUB_URL: GITHUB_URL },
) {
  return Object.entries(values)
    .filter(([key, value]) => key.endsWith('_URL') && value && LOCAL.test(new URL(value).hostname))
    .map(([key]) => key);
}
