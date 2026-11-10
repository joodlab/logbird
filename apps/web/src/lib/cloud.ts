import { APP_URL } from '../env';

/**
 * Logbird Cloud's public state, from config. Setting WEB_APP_URL means the hosted console takes sign-ins; sign-ups stay
 * restricted to invited teams and approved domains, so the primary call to action asks for access instead of promising
 * an account. Unset, the Cloud is waitlist-only and no page links to a console.
 *
 * Copy: marketing/copy/cloud.md and marketing/copy/README.md § Cloud CTA rule.
 */
export const CLOUD_OPEN = Boolean(APP_URL);

/**
 * The console's sign-in page. Always `/login`, never the console root: when the site and the console share an origin,
 * a signed-out visit to `/` shows the marketing home page.
 */
export const SIGN_IN_URL = APP_URL ? `${APP_URL}/login` : undefined;

/** The primary call to action, leading to the form on /contact. */
export const ACCESS_CTA = CLOUD_OPEN ? 'Request access' : 'Join the waitlist';

/** One line on where the Cloud stands, for small print under hero actions. */
export const CLOUD_STATUS_LINE = CLOUD_OPEN
  ? 'Logbird Cloud is in early access: sign-ups are limited to invited teams for now.'
  : 'Logbird Cloud is not open yet.';
