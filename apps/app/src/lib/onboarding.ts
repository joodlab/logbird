import type { ProjectSetup, WorkspaceSetup } from '@logbird/contracts';
import { CONSOLE_TEST_EVENT_SOURCE, isLogbirdGeneratedSource } from '@logbird/contracts';
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

/**
 * Whether the active workspace already has a project — the full-screen wizard is only for the first one. Always asks
 * the server: the cached project list is keyed without the workspace, so right after creating or switching to a
 * workspace it can still hold the previous workspace's projects.
 */
export async function activeWorkspaceHasProjects(queryClient: QueryClient): Promise<boolean> {
  try {
    const projects = await queryClient.fetchQuery({ ...projectsQuery(), staleTime: 0 });
    return projects.length > 0;
  } catch {
    // Unknown: keep the wizard reachable rather than bouncing to a list that may not load either.
    return false;
  }
}

/**
 * What the first-event step says when an event arrives. A console test event (a Logbird-generated source) proves the
 * pipeline, not the integration, so it never says "it works".
 */
/**
 * The toast shown when the first event arrives while the setup panel watches: the same facts as its card, so once the
 * backend has sent events (`lastEventAt` counts only those) it never asks for one again.
 */
export function firstEventToast(ingest: Pick<ProjectSetup['ingest'], 'firstEvent' | 'lastEventAt'>) {
  const copy = firstEventCopy(ingest.firstEvent?.source, true, Boolean(ingest.lastEventAt));
  return { title: copy.toastTitle, description: copy.toastDescription };
}

export function firstEventCopy(source: string | null | undefined, justArrived = true, backendSeen = false) {
  if (isLogbirdGeneratedSource(source)) {
    // Only the console's own test is called one; other Logbird-generated sources are named for what they are.
    const what = source === CONSOLE_TEST_EVENT_SOURCE ? 'Console test' : 'Event from Logbird';
    return {
      toastTitle: `${what} received`,
      // Like the card: once the backend has sent events, never ask for one again.
      toastDescription: backendSeen
        ? 'Your backend has sent events since: your integration works.'
        : 'Logbird is receiving events. Send one from your backend to check your integration.',
      cardTitle: backendSeen ? `${what} received — your backend has sent events since` : `${what} received — now send one from your backend`,
    };
  }
  return {
    toastTitle: 'First event received',
    toastDescription: 'Your integration works. Everything else builds on this.',
    cardTitle: justArrived ? 'It works — your first event just arrived' : 'First event received',
  };
}
