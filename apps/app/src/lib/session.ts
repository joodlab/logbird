import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import type { MeResponse } from '@trailmark/contracts';
import { ApiRequestError } from '@/lib/api/errors';
import { meQuery } from '@/lib/api/queries';

const LAST_PROJECT_KEY = 'trailmark.lastProject';

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
