import { shared } from '../content/shared';
import { SITE } from '../content/site';

/**
 * Logbird Cloud's public state, from config. Setting WEB_APP_URL means the hosted console takes sign-ins; sign-ups stay
 * restricted to invited teams and approved domains, so the primary call to action asks for access instead of promising
 * an account. Unset, the Cloud is waitlist-only and no page links to a console.
 *
 * Words: content/shared.ts. Brief: marketing/copy/cloud.md and marketing/copy/README.md § Cloud CTA rule.
 */
export const CLOUD_OPEN = SITE.cloudOpen;

/**
 * The console's sign-in page. Always `/login`, never the console root: when the site and the console share an origin,
 * a signed-out visit to `/` shows the marketing home page.
 */
export const SIGN_IN_URL = SITE.signInUrl;

/** The primary call to action, leading to the form on /contact. */
export const ACCESS_CTA = shared.accessCta;

/** One line on where the Cloud stands, for small print under hero actions. */
export const CLOUD_STATUS_LINE = shared.cloudStatusLine;
