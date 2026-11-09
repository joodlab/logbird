import { mayCreateAccount, parseSignupDomains } from '@logbird/auth/signup-policy';
import { describe, expect, it } from 'vitest';

const lookups = (accounts: string[] = [], invited: string[] = []) => ({
  hasAccount: async (email: string) => accounts.includes(email),
  hasPendingInvitation: async (email: string) => invited.includes(email),
});
const restricted = { mode: 'restricted' as const, domains: parseSignupDomains(' Example.com, @team.example.org ,,') };

describe('signup policy', () => {
  it('parses domains case-insensitively and ignores blanks and leading @', () => {
    expect([...restricted.domains]).toEqual(['example.com', 'team.example.org']);
  });

  it('lets anyone sign up when open', async () => {
    expect(await mayCreateAccount('someone@elsewhere.test', { mode: 'open', domains: new Set() }, lookups())).toBe(true);
  });

  it('restricted: allows approved domains, existing accounts and pending invitations only', async () => {
    const l = lookups(['member@elsewhere.test'], ['invited@elsewhere.test']);
    expect(await mayCreateAccount('New.Person@EXAMPLE.com', restricted, l)).toBe(true);
    expect(await mayCreateAccount('a@team.example.org', restricted, l)).toBe(true);
    expect(await mayCreateAccount('member@elsewhere.test', restricted, l)).toBe(true);
    expect(await mayCreateAccount('Invited@elsewhere.test', restricted, l)).toBe(true);
    expect(await mayCreateAccount('stranger@elsewhere.test', restricted, l)).toBe(false);
    // A look-alike subdomain is not the approved domain.
    expect(await mayCreateAccount('x@evil.example.com', restricted, l)).toBe(false);
    expect(await mayCreateAccount('x@example.com.evil.test', restricted, l)).toBe(false);
  });
});
