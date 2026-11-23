/**
 * The public WEB_* keys, in a module with no side effects: scripts/public-env.ts reads them before any site module
 * (src/env.ts reads process.env when it loads) is evaluated.
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
  'WEB_MAILBOX_PROVIDER',
  'WEB_FORM_RETENTION_MONTHS',
  'WEB_CHECKOUT_URL',
] as const;
