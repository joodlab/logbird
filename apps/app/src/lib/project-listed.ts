import type { QueryClient } from '@tanstack/react-query';
import { projectsQuery } from '@/lib/api/queries';

/**
 * Whether the workspace lists this project, so a stale link can be not found before any of its requests runs. The
 * cached list may be older than the project: one created a minute ago (in another tab, or by another member), or a
 * membership granted since. So an id the cache lacks is checked against a fresh list before it counts as missing.
 * When the list cannot be read, the project is assumed listed: the project's own request then decides.
 */
export async function projectIsListed(queryClient: QueryClient, projectId: string): Promise<boolean> {
  const has = (projects: readonly { id: string }[]) => projects.some((p) => p.id === projectId);
  const readAt = () => queryClient.getQueryState(projectsQuery().queryKey)?.dataUpdatedAt;
  try {
    const before = readAt();
    // A stale cached list still answers at once (navigation never waits on it) and is refreshed in the background.
    if (has(await queryClient.ensureQueryData({ ...projectsQuery(), revalidateIfStale: true }))) return true;
    // Read just now (a cold visit): that answer is fresh, so it settles it. Otherwise check a fresh list once.
    if (readAt() !== before) return false;
    return has(await queryClient.fetchQuery({ ...projectsQuery(), staleTime: 0 }));
  } catch {
    return true;
  }
}
