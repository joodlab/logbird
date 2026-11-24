// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';

// Browser storage as CI's test environment has it (some local Node versions leave it out).
const memoryStorage = () => {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => items.set(k, String(v)),
    removeItem: (k: string) => items.delete(k),
    clear: () => items.clear(),
    key: (i: number) => [...items.keys()][i] ?? null,
    get length() {
      return items.size;
    },
  };
};
for (const name of ['localStorage', 'sessionStorage'] as const)
  if (!window[name]) Object.defineProperty(window, name, { configurable: true, value: memoryStorage() });

vi.mock('@/lib/auth-client', () => ({ authCall: vi.fn(), authClient: { organization: { setActive: vi.fn() } } }));
const { forgetWorkspace, noteLostWorkspaces, takeLostWorkspaces, workspaceList } = await import('./session');

const acme = { id: 'ws_acme', name: 'Acme Example', slug: 'acme', role: 'member' };
const birch = { id: 'ws_birch', name: 'Birch Example', slug: 'birch', role: 'owner' };
const me = (id: string, organizations: (typeof acme)[]) => ({ user: { id, name: '', email: `${id}@example.invalid`, image: null }, organizations });

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

it('says nothing on a first visit, then names a workspace removed even when another one is active', () => {
  noteLostWorkspaces(me('alice', [acme, birch]));
  expect(takeLostWorkspaces('alice')).toEqual([]);
  // Removed from Acme while Birch was the one open: still noticed.
  noteLostWorkspaces(me('alice', [birch]));
  expect(takeLostWorkspaces('alice')).toEqual(['Acme Example']);
  // Read once.
  expect(takeLostWorkspaces('alice')).toEqual([]);
  noteLostWorkspaces(me('alice', [birch]));
  expect(takeLostWorkspaces('alice')).toEqual([]);
});

it('never shows one account a workspace another account on this browser lost', () => {
  noteLostWorkspaces(me('alice', [acme]));
  noteLostWorkspaces(me('alice', []));
  // Alice signs out without seeing it; Bob signs in on the same browser.
  noteLostWorkspaces(me('bob', [birch]));
  expect(takeLostWorkspaces('bob')).toEqual([]);
  expect(takeLostWorkspaces('alice')).toEqual(['Acme Example']);
});

it('stays quiet after leaving on purpose, and drops the earlier account-independent records', () => {
  window.localStorage.setItem('logbird.lastWorkspace', JSON.stringify({ id: 'ws_old', name: 'Someone Else' }));
  window.sessionStorage.setItem('logbird.lostWorkspace', 'Someone Else');
  noteLostWorkspaces(me('alice', [acme, birch]));
  expect(window.localStorage.getItem('logbird.lastWorkspace')).toBeNull();
  forgetWorkspace('alice', acme.id);
  noteLostWorkspaces(me('alice', [birch]));
  expect(takeLostWorkspaces('alice')).toEqual([]);
});

it('lists several lost workspaces by name, and survives storage that throws', () => {
  noteLostWorkspaces(me('alice', [acme, birch]));
  noteLostWorkspaces(me('alice', []));
  expect(workspaceList(takeLostWorkspaces('alice'))).toBe('Acme Example and Birch Example');
  expect(workspaceList(['A', 'B', 'C'])).toBe('A, B and C');
  const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  expect(() => noteLostWorkspaces(me('alice', []))).not.toThrow();
  expect(takeLostWorkspaces('alice')).toEqual([]);
  spy.mockRestore();
});
