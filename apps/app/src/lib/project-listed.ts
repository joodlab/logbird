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
  try {
    if (has(await queryClient.ensureQueryData(projectsQuery()))) return true;
    return has(await queryClient.fetchQuery({ ...projectsQuery(), staleTime: 0 }));
  } catch {
    return true;
  }
}
