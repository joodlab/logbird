import type { QueryClient } from '@tanstack/react-query';
import { projectsQuery } from '@/lib/api/queries';

/**
 * Whether the workspace lists this project, so a stale link can be not found before any of its requests runs. The
 * cached list may be older than the project: one created a minute ago (in another tab, or by another member), or a
 * membership granted since. So an id the cache lacks is checked against a fresh list before it counts as missing.
 * When the list cannot be read, the project is assumed listed: the project's own request then decides.
 */
/** What a route's notFound carries when the project itself is missing (not a page under it): the project route then
 * renders "Project not found" in a shell of its own. */
export const PROJECT_MISSING = 'project-missing';

export async function projectIsListed(queryClient: QueryClient, projectId: string): Promise<boolean> {
  const has = (projects: readonly { id: string }[]) => projects.some((p) => p.id === projectId);
  const readAt = () => queryClient.getQueryState(projectsQuery().queryKey)?.dataUpdatedAt;
  try {
    const before = readAt();
    // A stale cached list still answers at once (navigation never waits on it) and is refreshed in the background.
    if (has(await queryClient.ensureQueryData({ ...projectsQuery(), revalidateIfStale: true }))) return true;
    // The list changed while we waited (a cold visit's read, or a refresh already in flight landing first): the cache
    // now holds a fresh list, so it settles it. Read it from the cache, not the possibly older answer above.
    if (readAt() !== before) return has(queryClient.getQueryData<readonly { id: string }[]>(projectsQuery().queryKey) ?? []);
    return has(await queryClient.fetchQuery({ ...projectsQuery(), staleTime: 0 }));
  } catch {
    return true;
  }
}
