import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quietHrefWarnings, renderPages } from '../test/render-pages';

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

const OWNER_FACTS = {
  WEB_ORG_NAME: 'Example Operator Ltd',
  WEB_PRIVACY_EMAIL: 'privacy@example.test',
  WEB_LEGAL_ADDRESS: '1 Example Street, Example City',
  WEB_GOVERNING_LAW: 'the laws of Exampleland',
  WEB_HOSTING_PROVIDER: 'Example Hosting (Exampleland)',
  WEB_EMAIL_PROVIDER: 'Example Mail',
};

describe('legal pages', () => {
  beforeEach(quietHrefWarnings);
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('render real text with neutral wording while the owner facts are unset', async () => {
    const [privacy, terms] = await renderPages(['/legal/privacy', '/legal/terms']);
    for (const page of [privacy, terms]) {
      expect(text(page?.html ?? '')).not.toMatch(/placeholder|counsel-reviewed|lorem/i);
      expect(page?.html).toContain('dateTime="2026-11-10"');
    }
    const privacyText = text(privacy?.html ?? '');
    expect(privacyText).toContain('The operator of Logbird Cloud ("we")');
    // Without a privacy mailbox, rights requests go through the form's privacy topic.
    expect(privacy?.html).toContain('href="/contact?interest=privacy"');
    expect(privacyText).toContain('our server provider runs the servers');
    expect(privacyText).toContain('our email delivery provider sends sign-in codes');
    for (const fact of [
      '__Secure-logbird.session_token',
      'expires after 10 minutes',
      'up to 10 years',
      'from 7 days to 10 years',
      'jsDelivr',
      'Cloudflare',
    ]) {
      expect(privacyText).toContain(fact);
    }
    expect(text(terms?.html ?? '')).toContain('governed by the laws of the country where the operator is established');
    expect(text(terms?.html ?? '')).toContain('Logbird Cloud is free during early access');
  }, 30_000);

  it('name the operator, address, providers, law and privacy mailbox once they are configured', async () => {
    const [privacy, terms] = await renderPages(['/legal/privacy', '/legal/terms'], OWNER_FACTS);
    const privacyText = text(privacy?.html ?? '');
    expect(privacyText).toContain('Example Operator Ltd ("we")');
    expect(privacyText).toContain('Our address: 1 Example Street, Example City.');
    expect(privacyText).toContain('Example Hosting (Exampleland) runs the servers');
    expect(privacyText).toContain('Example Mail sends sign-in codes');
    expect(privacy?.html).toContain('href="mailto:privacy@example.test"');
    expect(privacy?.html).not.toContain('interest=privacy');
    expect(text(terms?.html ?? '')).toContain('governed by the laws of Exampleland');
  }, 30_000);

  it('are linked from the form and listed in the footer', async () => {
    const [contact] = await renderPages(['/contact']);
    expect(contact?.html).toContain('href="/legal/privacy"');
    expect(contact?.html).toContain('href="/legal/terms"');
    expect(contact?.html).toContain('value="privacy"');
  }, 30_000);
});
