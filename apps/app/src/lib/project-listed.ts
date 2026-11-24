import { PROJECT_IN_OTHER_WORKSPACE, projectInOtherWorkspaceErrorSchema } from '@logbird/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '@/lib/api/errors';
import { meQuery, projectQuery, projectsQuery } from '@/lib/api/queries';

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

/** A project in another of the person's workspaces (409 project_in_other_workspace): where it is, to offer a switch. */
export type ProjectElsewhere = {
  kind: 'project-elsewhere';
  workspaceId: string;
  workspaceName: string;
  /** The workspace the session has open, read fresh (another tab may have switched it); null when none is. */
  openWorkspaceName?: string | null;
};
const elsewhereDetails = projectInOtherWorkspaceErrorSchema.shape.error.shape.details;

/** The workspace a refused project request says the project is in, when it is one of the person's; else null. */
export function projectElsewhere(error: unknown): ProjectElsewhere | null {
  if (!(error instanceof ApiRequestError) || error.status !== 409 || error.code !== PROJECT_IN_OTHER_WORKSPACE) return null;
  const details = elsewhereDetails.safeParse(error.details);
  return details.success ? { kind: 'project-elsewhere', ...details.data } : null;
}

/**
 * Reads the project fresh, never from a cache another workspace filled (another tab may have switched the active one):
 * 'readable' (and the detail cache now holds it), in another of the person's workspaces (the server names it), or
 * missing for them (deleted, never theirs, or a workspace they left: one answer, so nothing is revealed). Any other
 * failure (offline, 5xx) is thrown, for the page's usual retry, rather than called missing.
 */
/** Adds the name of the workspace the session really has open (read fresh, not from this tab's cache). */
export async function withOpenWorkspace(queryClient: QueryClient, elsewhere: ProjectElsewhere): Promise<ProjectElsewhere> {
  try {
    const me = await queryClient.fetchQuery({ ...meQuery(), staleTime: 0 });
    return { ...elsewhere, openWorkspaceName: me.organizations.find((o) => o.id === me.activeOrganizationId)?.name ?? null };
  } catch {
    return { ...elsewhere, openWorkspaceName: null };
  }
}

/**
 * The project each query client last read as readable on a real visit (never a preload: hovering a link must not mark a
 * project as visited): moving between that project's own pages reuses the read.
 */
const confirmed = new WeakMap<QueryClient, string>();
export const confirmedProject = (queryClient: QueryClient) => confirmed.get(queryClient);

export async function readProject(
  queryClient: QueryClient,
  projectId: string,
  { visit = true }: { visit?: boolean } = {},
): Promise<'readable' | ProjectElsewhere | typeof PROJECT_MISSING> {
  try {
    // networkMode always: offline, the read fails (for the retry UI) instead of pausing the navigation indefinitely.
    await queryClient.fetchQuery({ ...projectQuery(projectId), staleTime: 0, networkMode: 'always' });
    if (visit) confirmed.set(queryClient, projectId);
    return 'readable';
  } catch (error) {
    if (visit) confirmed.delete(queryClient);
    const elsewhere = projectElsewhere(error);
    if (elsewhere) return withOpenWorkspace(queryClient, elsewhere);
    if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) return PROJECT_MISSING;
    throw error;
  }
}
