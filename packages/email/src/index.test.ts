import { describe, expect, it } from 'vitest';
import { renderInvitation } from './index';

const props = {
  email: 'lina@acme.test',
  workspace: 'Acme',
  inviterName: 'Raed Bahri',
  inviterEmail: 'raed@acme.test',
  role: 'admin',
  url: 'http://localhost:4600/accept-invitation/inv_123',
  expiresAt: new Date('2026-11-12T10:00:00Z'),
};

describe('invitation email', () => {
  it('names the inviter, workspace, role, link and expiry in the HTML part', async () => {
    const { html } = await renderInvitation(props);
    expect(html).toContain('Join Acme on Trailmark');
    expect(html).toContain('Raed Bahri');
    expect(html).toContain('Admin');
    expect(html).toContain('href="http://localhost:4600/accept-invitation/inv_123"');
    expect(html).toContain('November 12, 2026');
  });
  it('has a readable plain-text fallback with the raw link', async () => {
    const { text } = await renderInvitation(props);
    expect(text).toContain('Raed Bahri (raed@acme.test) invited you to the Acme workspace as an admin.');
    expect(text).toContain('Accept the invitation: http://localhost:4600/accept-invitation/inv_123');
    expect(text).not.toContain('<');
  });
});
