/**
 * Cloudflare's Email Address Obfuscation rewrites every address in the HTML it proxies: `mailto:` links become
 * `/cdn-cgi/l/email-protection` (which needs JavaScript) and code samples show "[email protected]". Cloudflare skips
 * anything between `<!--email_off-->` and `<!--/email_off-->`
 * (https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/), so every prerendered page is
 * wrapped in that pair.
 *
 * The comments sit outside `<html>` (after the doctype, and after `</html>`), where React never hydrates, so they can't
 * cause a hydration mismatch, and they leave inline scripts (and so their CSP hashes) untouched. Cloudflare documents
 * the pair around an address, not around a whole document, so `pnpm check:live` fails on any page the edge still
 * rewrites; the documented fallback is a Configuration Rule that turns Email Obfuscation off for the site's hostname.
 * The site publishes only role mailboxes and example addresses on purpose.
 */
export const EMAIL_OFF = '<!--email_off-->';
export const EMAIL_OFF_END = '<!--/email_off-->';

/** What Cloudflare's obfuscation leaves in a page it rewrote. */
export const OBFUSCATED_EMAIL = /\/cdn-cgi\/l\/email-protection|__cf_email__|data-cfemail/;

export function withEmailOff(html: string): string {
  if (html.includes(EMAIL_OFF)) {
    return html;
  }
  const doctype = /^\s*<!doctype html>/i.exec(html);
  const head = doctype ? doctype[0] : '';
  const rest = html.slice(head.length);
  return `${head}${EMAIL_OFF}${rest}${rest.endsWith('\n') ? '' : '\n'}${EMAIL_OFF_END}\n`;
}
