import type { WorkspaceSetup } from '@logbird/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { meQuery, projectsQuery, workspaceSetupQuery } from '@/lib/api/queries';
import { activeRole, canDo } from '@/lib/permissions';
import { lastProject } from '@/lib/session';

const SKIP_KEY = (projectId: string) => `logbird.onboarding.skippedFirstEvent.${projectId}`;

/** "Skip for now" on the first-event step: `/` stops sending this browser back there for that project. */
export function skipFirstEvent(projectId: string) {
  try {
    window.localStorage.setItem(SKIP_KEY(projectId), '1');
  } catch {
    // Without storage the next visit to `/` resumes at the first-event step, which is still correct.
  }
}

function skippedFirstEvent(projectId: string) {
  try {
    return window.localStorage.getItem(SKIP_KEY(projectId)) === '1';
  } catch {
    return false;
  }
}

/** Overview of the remembered project when it is still in this workspace, else the server's choice. */
function overviewOf(setup: WorkspaceSetup, fallback: string | null) {
  const remembered = lastProject();
  const projectId = setup.projects.find((p) => p.projectId === remembered)?.projectId ?? fallback ?? setup.projects[0]?.projectId;
  return projectId ? redirect({ to: '/p/$projectId', params: { projectId } }) : redirect({ to: '/projects' });
}

/**
 * Where `/` (and therefore every post-sign-in redirect) should go: the onboarding step this person is missing,
 * computed server-side from real state (GET /api/workspace/setup), so leaving and coming back resumes.
 */
export async function resolveOnboarding(queryClient: QueryClient) {
  let setup: WorkspaceSetup;
  try {
    setup = await queryClient.fetchQuery(workspaceSetupQuery());
  } catch {
    // Setup summary unavailable: fall back to "first project" so the console stays reachable.
    const projects = await queryClient.fetchQuery(projectsQuery());
    const first = projects[0];
    return first ? redirect({ to: '/p/$projectId', params: { projectId: first.id } }) : redirect({ to: '/projects' });
  }
  const { next, projectId } = setup.onboarding;
  // Members cannot create projects or keys: never park them on a step only an admin can finish.
  const admin = canDo(activeRole(queryClient.getQueryData(meQuery().queryKey)), 'project.create');
  if (!admin && (next === 'project' || next === 'first_event')) return overviewOf(setup, projectId);
  switch (next) {
    case 'profile':
      return redirect({ to: '/onboarding/profile' });
    case 'workspace':
      return redirect({ to: '/onboarding' });
    case 'project':
      return redirect({ to: '/onboarding/project' });
    case 'first_event':
      if (projectId && !skippedFirstEvent(projectId)) return redirect({ to: '/onboarding/first-event/$projectId', params: { projectId } });
      return overviewOf(setup, projectId);
    default:
      return overviewOf(setup, projectId);
  }
}
