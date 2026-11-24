import type { MeResponse } from '@logbird/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { ApiRequestError } from '@/lib/api/errors';
import { meQuery } from '@/lib/api/queries';
import { authClient } from '@/lib/auth-client';

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
  noteLostWorkspace(me);
  if (me.organizations.length === 0) return me;
  const active = me.organizations.find((o) => o.id === me.activeOrganizationId);
  if (active) {
    rememberWorkspace(active);
    return me;
  }
  const first = me.organizations[0];
  if (!first) return me;
  await authClient.organization.setActive({ organizationId: first.id });
  rememberWorkspace(first);
  await queryClient.invalidateQueries({ queryKey: meQuery().queryKey });
  return queryClient.fetchQuery({ ...meQuery(), staleTime: 0 });
}

const LAST_WORKSPACE_KEY = 'logbird.lastWorkspace';
const LOST_WORKSPACE_KEY = 'logbird.lostWorkspace';

/** The workspace this browser last showed, so losing access to it can be said by name. */
export function rememberWorkspace(workspace: { id: string; name: string }): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_WORKSPACE_KEY, JSON.stringify({ id: workspace.id, name: workspace.name }));
  } catch {
    // Storage unavailable: a removal then reads as no workspace, as before.
  }
}

/**
 * When the workspace this browser last showed is no longer among the person's workspaces (an owner removed them), keep
 * its name for one notice: "You no longer have access to <workspace>". Leaving on purpose forgets it first.
 * Browser storage only: route guards also run on the server for a full page load, so the page that shows the notice
 * calls this again after mount.
 */
export function noteLostWorkspace(me: Pick<MeResponse, 'organizations'>): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(LAST_WORKSPACE_KEY);
    if (!raw) return;
    const last = JSON.parse(raw) as { id?: string; name?: string };
    if (!last.id || me.organizations.some((o) => o.id === last.id)) return;
    window.localStorage.removeItem(LAST_WORKSPACE_KEY);
    window.sessionStorage.setItem(LOST_WORKSPACE_KEY, last.name ?? '');
  } catch {
    // Storage unavailable: no notice.
  }
}

/** The name of a workspace the person lost access to since this browser last showed it, read once; else null. */
export function takeLostWorkspace(): string | null {
  try {
    const name = window.sessionStorage.getItem(LOST_WORKSPACE_KEY);
    window.sessionStorage.removeItem(LOST_WORKSPACE_KEY);
    return name;
  } catch {
    return null;
  }
}

/** Leaving a workspace on purpose: forget it, so no "no longer have access" notice follows. */
export function forgetWorkspace(workspaceId: string): void {
  try {
    const raw = window.localStorage.getItem(LAST_WORKSPACE_KEY);
    if (raw && (JSON.parse(raw) as { id?: string }).id === workspaceId) window.localStorage.removeItem(LAST_WORKSPACE_KEY);
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
