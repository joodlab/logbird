/**
 * Cloudflare's Email Address Obfuscation rewrites every address in the HTML it proxies: `mailto:` links become
 * `/cdn-cgi/l/email-protection` (which needs JavaScript) and code samples show "[email protected]". It skips anything
 * between `<!--email_off-->` and `<!--email_on-->`, so every prerendered page is wrapped in those markers.
 *
 * The markers sit outside `<html>` (after the doctype, and after `</html>`), where React never hydrates, so they can't
 * cause a hydration mismatch. The site publishes only role mailboxes and example addresses on purpose.
 */
export const EMAIL_OFF = '<!--email_off-->';
export const EMAIL_ON = '<!--email_on-->';

export function withEmailOff(html: string): string {
  if (html.includes(EMAIL_OFF)) {
    return html;
  }
  const doctype = /^\s*<!doctype html>/i.exec(html);
  const head = doctype ? doctype[0] : '';
  const rest = html.slice(head.length);
  return `${head}${EMAIL_OFF}${rest}${rest.endsWith('\n') ? '' : '\n'}${EMAIL_ON}\n`;
}
