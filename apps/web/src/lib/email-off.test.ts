import { describe, expect, it } from 'vitest';
import { EMAIL_OFF, EMAIL_ON, withEmailOff } from './email-off';

describe('withEmailOff', () => {
  it('wraps the document outside <html>, after the doctype', () => {
    const html = '<!DOCTYPE html><html lang="en"><body><a href="mailto:security@example.test">x</a></body></html>';
    const out = withEmailOff(html);
    expect(out.startsWith(`<!DOCTYPE html>${EMAIL_OFF}<html`)).toBe(true);
    expect(out.endsWith(`</html>\n${EMAIL_ON}\n`)).toBe(true);
    expect(out.indexOf('mailto:')).toBeGreaterThan(out.indexOf(EMAIL_OFF));
    expect(out.indexOf('mailto:')).toBeLessThan(out.indexOf(EMAIL_ON));
  });

  it('is idempotent, so a rebuild never adds a second pair', () => {
    const once = withEmailOff('<!doctype html><html></html>\n');
    expect(withEmailOff(once)).toBe(once);
    expect(once.split(EMAIL_OFF)).toHaveLength(2);
  });

  it('handles a document without a doctype', () => {
    expect(withEmailOff('<html></html>')).toBe(`${EMAIL_OFF}<html></html>\n${EMAIL_ON}\n`);
  });
});
