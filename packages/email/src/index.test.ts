import { HtmlValidate } from 'html-validate';
import { describe, expect, it, vi } from 'vitest';
import { clientIp, describeUserAgent, formatRelative } from './format';
import { createFixtures, type EmailDefinition, emails, fixtures, type RenderedEmail, renderEmail } from './index';

// Email HTML is XHTML-transitional tables by necessity; everything else in the standard + a11y presets applies.
const validator = new HtmlValidate({
  extends: ['html-validate:standard', 'html-validate:a11y'],
  rules: { 'doctype-html': 'off', 'no-deprecated-attr': 'off', 'no-inline-style': 'off' },
});

const UNRESOLVED = /undefined|\bnull\b|NaN|Invalid Date|\[object Object\]|\{\{|\}\}/;
const visibleText = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ');
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]?.replaceAll('&amp;', '&') ?? '');

const cases = Object.entries(emails).map(([key, email]) => ({
  key,
  email: email as EmailDefinition<object>,
  props: fixtures[key as keyof typeof fixtures] as object,
}));

describe.each(cases)('$key email', ({ email, props }) => {
  let rendered: RenderedEmail;
  const get = async () => {
    rendered ??= await renderEmail(email, props);
    return rendered;
  };

  it('is valid, accessible HTML', async () => {
    const { html } = await get();
    const report = await validator.validateString(html);
    const messages = report.results.flatMap((r) => r.messages.map((m) => `${m.ruleId}: ${m.message} (${m.selector})`));
    expect(messages).toEqual([]);
    expect(html).toMatch(/^<!DOCTYPE html/);
    expect(html).toContain('<html');
    expect(html).toMatch(/<html[^>]* lang="en"/);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('<meta content="light dark" name="color-scheme"/>');
  });

  it('marks every layout table as presentational', async () => {
    const { html } = await get();
    const tables = html.match(/<table[^>]*>/g) ?? [];
    expect(tables.length).toBeGreaterThan(3);
    for (const table of tables) expect(table).toContain('role="presentation"');
  });

  it('loads nothing remote: no images, fonts, scripts or tracking pixels', async () => {
    const { html } = await get();
    expect(html).not.toMatch(/<img|<link|<script|@import|url\(/i);
    expect(html).not.toMatch(/src="/);
  });

  it('stays well under the 102 KB Gmail clipping limit', async () => {
    const { html, text } = await get();
    expect(Buffer.byteLength(html)).toBeLessThan(100 * 1024);
    expect(Buffer.byteLength(text)).toBeLessThan(10 * 1024);
  });

  it('has no unresolved placeholders', async () => {
    const r = await get();
    expect(visibleText(r.html)).not.toMatch(UNRESOLVED);
    expect(r.text).not.toMatch(UNRESOLVED);
    expect(r.subject).not.toMatch(UNRESOLVED);
    expect(r.preview).not.toMatch(UNRESOLVED);
  });

  it('has a one-line subject and a preheader that adds information', async () => {
    const r = await get();
    expect(r.subject).not.toMatch(/\n/);
    expect(r.subject.length).toBeLessThanOrEqual(70);
    expect(r.preview.length).toBeGreaterThan(20);
    expect(r.preview).not.toBe(r.subject);
    expect(r.html).toContain(r.preview);
  });

  it('only links to https URLs, and the plain-text part carries every link', async () => {
    const { html, text } = await get();
    for (const href of hrefs(html)) {
      expect(href).toMatch(/^https:\/\//);
      expect(text).toContain(href);
    }
  });

  it('has a plain-text part with the footer and no markup', async () => {
    const { text } = await get();
    expect(text).not.toMatch(/<[a-z/!]/i);
    expect(text).toContain('You received this email because');
    expect(text).toContain('Trailmark · open-source audit logs · audit.acme.test');
    expect(text).toMatchSnapshot();
  });

  it('includes the "why you got this" footer and the product URL in the HTML', async () => {
    const { html } = await get();
    expect(html).toContain('You received this email because');
    expect(html).toContain('href="https://audit.acme.test"');
  });
});

describe('sign-in code', () => {
  it('puts the code in the subject, the body and the text part, with expiry and request details', async () => {
    const r = await renderEmail(emails.signInCode, fixtures.signInCode);
    expect(r.subject).toBe('482913 is your Trailmark sign-in code');
    expect(r.preview).toBe('Expires in 10 minutes. Requested from Chrome on Windows, 203.0.113.24.');
    for (const part of [r.html, r.text]) {
      expect(part).toContain('482913');
      expect(part).toContain('Expires in 10 minutes, at 14:42 UTC');
      expect(part).toContain('Nov 5, 2026, 14:32 UTC');
      expect(part).toContain('Chrome on Windows');
      expect(part).toContain('203.0.113.24');
      expect(part).toContain('lina@acme.test');
    }
    expect(r.html).toContain('Didn’t request this?');
  });

  it('drops device rows it does not know and falls back to the request time in the preheader', async () => {
    const { userAgent: _ua, ip: _ip, ...props } = fixtures.signInCode;
    const r = await renderEmail(emails.signInCode, props);
    expect(r.html).not.toContain('IP address');
    expect(r.html).not.toContain('>Device<');
    expect(r.preview).toBe('Expires in 10 minutes. Requested Nov 5, 2026, 14:32 UTC.');
  });

  it('uses verification wording for non-sign-in codes', async () => {
    const r = await renderEmail(emails.signInCode, { ...fixtures.signInCode, purpose: 'email-verification' });
    expect(r.subject).toBe('482913 is your Trailmark verification code');
    expect(r.html).toContain('Your verification code');
  });
});

describe('invitation', () => {
  it('names inviter, workspace, role with its meaning, invited address, expiry, button and raw link', async () => {
    const r = await renderEmail(emails.invitation, fixtures.invitation);
    expect(r.subject).toBe('Sami Nasser invited you to Acme on Trailmark');
    expect(r.preview).toBe('Join as Admin. The invitation expires in 2 days.');
    for (const part of [r.html, r.text]) {
      expect(part).toContain('Join Acme on Trailmark');
      expect(part).toContain('Sami Nasser');
      expect(part).toContain('sami@acme.test');
      expect(part).toContain('Manages projects, API keys, retention and members.');
      expect(part).toContain('lina@acme.test');
      expect(part).toContain('Nov 7, 2026, 14:32 UTC (in 2 days)');
    }
    // Button (VML for Outlook + link for everyone else) and the raw fallback link.
    expect(r.html).toContain('<v:roundrect');
    expect(r.html.match(/href="https:\/\/audit\.acme\.test\/accept-invitation\/inv_7Hc2kP9xQm"/g)?.length).toBe(3);
    expect(r.text).toContain('Accept the invitation:\nhttps://audit.acme.test/accept-invitation/inv_7Hc2kP9xQm');
  });

  it('does not repeat the address when the inviter has no name', async () => {
    const r = await renderEmail(emails.invitation, { ...fixtures.invitation, inviterName: 'sami@acme.test' });
    expect(r.text).not.toContain('sami@acme.test (sami@acme.test)');
  });

  it('escapes hostile workspace names and URLs, including inside the raw Outlook button', async () => {
    const r = await renderEmail(emails.invitation, {
      ...fixtures.invitation,
      workspace: '<script>alert(1)</script> "Acme"',
      url: 'https://audit.acme.test/accept-invitation/x"><script>y</script>',
    });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
    expect((await validator.validateString(r.html)).valid).toBe(true);
  });
});

describe('member joined and role changed', () => {
  it('tells the inviter who joined, with which role', async () => {
    const r = await renderEmail(emails.memberJoined, fixtures.memberJoined);
    expect(r.subject).toBe('Lina Haddad joined Acme on Trailmark');
    expect(r.text).toContain('Lina Haddad accepted your invitation and is now a member of Acme as an Admin.');
    expect(r.text).toContain('you invited lina@acme.test to the Acme workspace.');
  });

  it('tells a member their new and previous role and who changed it', async () => {
    const r = await renderEmail(emails.roleChanged, fixtures.roleChanged);
    expect(r.subject).toBe('Your role in Acme is now Admin');
    expect(r.text).toContain('Sami Nasser (sami@acme.test) changed your role from Member to Admin.');
    expect(r.html).toContain('Previous role');
  });
});

describe('package surface', () => {
  it('names every email and points its recipient at an address prop', () => {
    for (const [key, email] of Object.entries(emails)) {
      const props = fixtures[key as keyof typeof fixtures] as Record<string, unknown>;
      expect(email.name.length).toBeGreaterThan(3);
      expect(props[email.recipient as string]).toMatch(/^[^@\s]+@[^@\s]+$/);
    }
    expect(new Set(Object.values(emails).map((e) => e.id)).size).toBe(Object.keys(emails).length);
  });

  it('builds fixtures for another install and clock', () => {
    const now = new Date('2027-01-01T00:00:00Z');
    const f = createFixtures({ appUrl: 'https://trail.example.org', now });
    expect(f.invitation.url).toBe('https://trail.example.org/accept-invitation/inv_7Hc2kP9xQm');
    expect(f.invitation.expiresAt.toISOString()).toBe('2027-01-03T00:00:00.000Z');
    expect(f.signInCode.requestedAt).toBe(now);
  });

  it('renders without SMTP: the main entry never loads nodemailer or the env', async () => {
    vi.resetModules();
    vi.doMock('nodemailer', () => {
      throw new Error('nodemailer imported by @trailmark/email');
    });
    vi.doMock('./env', () => {
      throw new Error('env imported by @trailmark/email');
    });
    const entry = await import('./index');
    const { html } = await entry.renderEmail(entry.emails.signInCode, entry.fixtures.signInCode);
    expect(html).toContain('482913');
    vi.doUnmock('nodemailer');
    vi.doUnmock('./env');
  });
});

describe('format helpers', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', 'Chrome on Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 'Safari on macOS'],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0', 'Firefox on Linux'],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
      'Edge on Windows',
    ],
    ['curl/8.7.1', 'curl'],
    ['', undefined],
    ['something-unknown', undefined],
  ])('describes %s', (ua, expected) => {
    expect(describeUserAgent(ua)).toBe(expected);
  });

  it('formats coarse relative times', () => {
    const now = new Date('2026-11-05T00:00:00Z');
    expect(formatRelative(new Date('2026-11-05T00:10:00Z'), now)).toBe('in 10 minutes');
    expect(formatRelative(new Date('2026-11-05T01:00:00Z'), now)).toBe('in 1 hour');
    expect(formatRelative(new Date('2026-11-07T00:00:00Z'), now)).toBe('in 2 days');
    expect(formatRelative(new Date('2026-11-04T00:00:00Z'), now)).toBe('now');
  });

  it('takes the client hop of X-Forwarded-For', () => {
    expect(clientIp('203.0.113.24, 10.0.0.1')).toBe('203.0.113.24');
    expect(clientIp('')).toBeUndefined();
    expect(clientIp(undefined)).toBeUndefined();
  });
});
