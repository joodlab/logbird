import { mayCreateAccount, mayCreateWorkspace, parseSignupDomains } from '@logbird/auth/signup-policy';
import { describe, expect, it } from 'vitest';

const lookups = (accounts: string[] = [], invited: string[] = [], linkDomains: string[] = []) => ({
  hasAccount: async (email: string) => accounts.includes(email),
  hasPendingInvitation: async (email: string) => invited.includes(email),
  hasActiveDomainInviteLink: async (domain: string) => linkDomains.includes(domain),
});
const restricted = { mode: 'restricted' as const, domains: parseSignupDomains(' Example.com, @team.example.org ,,') };
const open = { mode: 'open' as const, domains: new Set<string>() };

describe('signup policy', () => {
  it('parses domains case-insensitively and ignores blanks and leading @', () => {
    expect([...restricted.domains]).toEqual(['example.com', 'team.example.org']);
  });

  it('lets anyone sign up and create workspaces when open', async () => {
    expect(await mayCreateAccount('someone@elsewhere.test', open, lookups())).toBe(true);
    expect(mayCreateWorkspace('someone@elsewhere.test', open)).toBe(true);
  });

  it('restricted: admits approved domains, existing accounts, invitees and domain invite links only', async () => {
    const l = lookups(['member@elsewhere.test'], ['invited@elsewhere.test'], ['partner.test']);
    expect(await mayCreateAccount('New.Person@EXAMPLE.com', restricted, l)).toBe(true);
    expect(await mayCreateAccount('a@team.example.org', restricted, l)).toBe(true);
    expect(await mayCreateAccount('Member@elsewhere.test', restricted, l)).toBe(true);
    expect(await mayCreateAccount('Invited@elsewhere.test', restricted, l)).toBe(true);
    expect(await mayCreateAccount('someone@Partner.test', restricted, l)).toBe(true);
    expect(await mayCreateAccount('stranger@elsewhere.test', restricted, l)).toBe(false);
    // Look-alike domains are not the approved domain.
    expect(await mayCreateAccount('x@evil.example.com', restricted, l)).toBe(false);
    expect(await mayCreateAccount('x@example.com.evil.test', restricted, l)).toBe(false);
  });

  it('restricted: only approved domains may create workspaces', () => {
    expect(mayCreateWorkspace('owner@example.com', restricted)).toBe(true);
    expect(mayCreateWorkspace('member@elsewhere.test', restricted)).toBe(false);
  });
});
