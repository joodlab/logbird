import type { MeResponse } from '@logbird/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { ApiRequestError } from '@/lib/api/errors';
import { meQuery } from '@/lib/api/queries';
import { authCall, authClient } from '@/lib/auth-client';

const LAST_PROJECT_KEY = 'logbird.lastProject';

/** Load the signed-in user, or send them to /login (keeping where they were going). */
export async function requireMe(queryClient: QueryClient, href?: string): Promise<MeResponse> {
  try {
    // fetchQuery (not ensureQueryData): an invalidated session/org list must be re-read before guarding.
    return await queryClient.fetchQuery(meQuery());
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) {
      queryClient.removeQueries({ queryKey: meQuery().queryKey });
      throw redirect({ to: '/login', search: href && href !== '/' ? { redirect: href } : {} });
    }
    throw error;
  }
}

/**
 * A fresh better-auth session has no active organization, and every project endpoint is scoped to
 * it. Activate the first workspace when needed and return the refreshed `me`.
 */
export async function ensureActiveWorkspace(queryClient: QueryClient, me: MeResponse): Promise<MeResponse> {
  noteLostWorkspaces(me);
  if (me.organizations.length === 0) return me;
  if (me.organizations.some((o) => o.id === me.activeOrganizationId)) return me;
  const first = me.organizations[0];
  if (!first) return me;
  // A refused switch fails the guard here, rather than showing a workspace that is not the active one.
  await authCall(authClient.organization.setActive({ organizationId: first.id }));
  // Everything cached was read for the workspace that is no longer active (its project list is keyed without it).
  queryClient.clear();
  return queryClient.fetchQuery({ ...meQuery(), staleTime: 0 });
}

/** Per signed-in person, so another account on this browser never learns a workspace name. */
const knownKey = (userId: string) => `logbird.workspaces.${userId}`;
const lostKey = (userId: string) => `logbird.lostWorkspaces.${userId}`;
/** Earlier, account-independent records: dropped on sight. */
const LEGACY_KEYS = ['logbird.lastWorkspace', 'logbird.lostWorkspace'];

type Known = { id: string; name: string }[];
function readJson<T>(storage: Storage, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Compares the person's workspaces with the ones this browser last saw them in. A workspace that is gone (an owner or
 * admin removed them, or they left on another device) is kept by name for one notice: "You no longer have access to
 * <workspace>". Leaving here forgets it first, so no notice follows. Storage unavailable: no notice.
 */
export function noteLostWorkspaces(me: Pick<MeResponse, 'user' | 'organizations'>): void {
  try {
    for (const key of LEGACY_KEYS) window.localStorage.removeItem(key);
    const known = readJson<Known | null>(window.localStorage, knownKey(me.user.id), null);
    const now = me.organizations.map((o) => ({ id: o.id, name: o.name }));
    window.localStorage.setItem(knownKey(me.user.id), JSON.stringify(now));
    // First visit on this browser: nothing to compare with.
    if (!known) return;
    const lost = known.filter((k) => !now.some((o) => o.id === k.id)).map((k) => k.name);
    if (!lost.length) return;
    const pending = readJson<string[]>(window.sessionStorage, lostKey(me.user.id), []);
    window.sessionStorage.setItem(lostKey(me.user.id), JSON.stringify([...pending, ...lost.filter((n) => !pending.includes(n))]));
  } catch {
    // Storage unavailable: no notice.
  }
}

/** The names of workspaces this person lost access to since this browser last saw them, read once; else []. */
export function takeLostWorkspaces(userId: string): string[] {
  try {
    const names = readJson<string[]>(window.sessionStorage, lostKey(userId), []);
    window.sessionStorage.removeItem(lostKey(userId));
    return names;
  } catch {
    return [];
  }
}

/** "Acme", "Acme and Birch", "Acme, Birch and Cedar". */
export const workspaceList = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** Leaving a workspace on purpose: forget it, so no "no longer have access" notice follows. */
export function forgetWorkspace(userId: string, workspaceId: string): void {
  try {
    const known = readJson<Known>(window.localStorage, knownKey(userId), []);
    window.localStorage.setItem(knownKey(userId), JSON.stringify(known.filter((k) => k.id !== workspaceId)));
  } catch {
    // Storage unavailable.
  }
}

export function rememberProject(projectId: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    // Storage unavailable: the index route falls back to the first project.
  }
}

export function lastProject(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

/** Only allow same-app relative redirects after sign-in. */
export function safeRedirect(target: string | undefined): string {
  if (!target?.startsWith('/') || target.startsWith('//') || target.startsWith('/login')) return '/';
  return target;
}

/**
 * A refused project request may mean the person lost the active workspace since `me` was last read (it is cached for a
 * while): read it again, and start over at `/` if the active workspace is no longer theirs, where the loss is noted.
 */
export async function redirectIfWorkspaceLost(queryClient: QueryClient): Promise<void> {
  const me = await queryClient.fetchQuery({ ...meQuery(), staleTime: 0 });
  if (!me.organizations.some((o) => o.id === me.activeOrganizationId)) throw redirect({ to: '/' });
}
