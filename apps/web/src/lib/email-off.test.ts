import { describe, expect, it } from 'vitest';
import { OBFUSCATED_EMAIL, withEmailOff } from './email-off';

// Written out here rather than imported, so a wrong constant in email-off.ts can't pass its own test. The pair is the
// one Cloudflare documents: https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/
const OPEN = '<!--email_off-->';
const CLOSE = '<!--/email_off-->';

describe('withEmailOff', () => {
  it("wraps the document in Cloudflare's documented pair, outside <html> and after the doctype", () => {
    const html = '<!DOCTYPE html><html lang="en"><body><a href="mailto:security@example.test">x</a></body></html>';
    const out = withEmailOff(html);
    expect(out).toBe(`<!DOCTYPE html>${OPEN}<html lang="en"><body><a href="mailto:security@example.test">x</a></body></html>\n${CLOSE}\n`);
    expect(out).not.toContain('email_on');
  });

  it('leaves the element tree and inline scripts byte for byte', () => {
    const inner = '<html><head><script>window.x="a@example.test"</script></head><body></body></html>';
    const out = withEmailOff(`<!doctype html>${inner}`);
    expect(out.slice(out.indexOf(OPEN) + OPEN.length, out.lastIndexOf(CLOSE)).trim()).toBe(inner);
  });

  it('is idempotent, so a rebuild never adds a second pair', () => {
    const once = withEmailOff('<!doctype html><html></html>\n');
    expect(withEmailOff(once)).toBe(once);
    expect(once.split(OPEN)).toHaveLength(2);
    expect(once.split(CLOSE)).toHaveLength(2);
  });

  it('handles a document without a doctype', () => {
    expect(withEmailOff('<html></html>')).toBe(`${OPEN}<html></html>\n${CLOSE}\n`);
  });

  it('recognises a page the edge rewrote', () => {
    expect(OBFUSCATED_EMAIL.test('<a href="/cdn-cgi/l/email-protection#14777b">')).toBe(true);
    expect(OBFUSCATED_EMAIL.test('<span class="__cf_email__" data-cfemail="fb98">[email&#160;protected]</span>')).toBe(true);
    expect(OBFUSCATED_EMAIL.test('<a href="mailto:security@example.test">security@example.test</a>')).toBe(false);
  });
});
