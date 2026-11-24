import { Button } from '@logbird/ui/components/ui/button';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, notFound, Outlet, retainSearchParams, useRouter } from '@tanstack/react-router';
import { Loader2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { NotFound } from '@/components/not-found';
import { PageSkeleton } from '@/components/route-states';
import { AppShell } from '@/components/shell/app-shell';
import { ApiRequestError, errorMessage } from '@/lib/api/errors';
import { projectQuery, projectsQuery, viewsQuery } from '@/lib/api/queries';
import { authCall, authClient } from '@/lib/auth-client';
import { PROJECT_MISSING, type ProjectElsewhere, projectElsewhere, readProject } from '@/lib/project-listed';
import { rememberProject } from '@/lib/session';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId')({
  // A shared URL can carry `range=0` or `range=true`, which the router decodes as a number or boolean: drop it, so the page
  // falls back to its default range instead of failing validation.
  validateSearch: z.object({ range: z.string().optional().catch(undefined) }),
  search: { middlewares: [retainSearchParams(['range'])] },
  // On entering a project (a link, a bookmark, another project), it is read fresh before any of its pages load: a cache
  // filled while another workspace was active (in this tab or another) never stands in for access. A project in another
  // of the person's workspaces is named, so they can switch to it (never switched silently); one that is not theirs is
  // not found; a failure to read it shows the usual error with a retry. Moving between pages of the same project reuses
  // that read.
  beforeLoad: async ({ context, params, cause }) => {
    if (cause === 'stay') return;
    const outcome = await readProject(context.queryClient, params.projectId);
    if (outcome !== 'readable') throw notFound({ data: outcome });
  },
  loader: async ({ context, params }) => {
    try {
      const [project] = await Promise.all([
        context.queryClient.ensureQueryData(projectQuery(params.projectId)),
        context.queryClient.ensureQueryData(projectsQuery()),
      ]);
      context.queryClient.prefetchQuery(viewsQuery(params.projectId));
      return { project };
    } catch (error) {
      const elsewhere = projectElsewhere(error);
      if (elsewhere) throw notFound({ data: elsewhere });
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) throw notFound({ data: PROJECT_MISSING });
      throw error;
    }
  },
  head: ({ loaderData }) => ({ meta: [{ title: loaderData ? `${loaderData.project.name} · Logbird` : 'Logbird' }] }),
  pendingComponent: () => (
    <AppShell>
      <PageSkeleton />
    </AppShell>
  ),
  // A missing project replaces the layout: it renders inside a shell of its own, so the sidebar and the workspace
  // switcher stay and the way out is one click. Any other not-found here (an unknown page under a real project) renders
  // inside the project's layout, which stays mounted: a page-level fallback, never a second shell.
  notFoundComponent: ({ data }) =>
    isElsewhere(data) ? (
      <ProjectInOtherWorkspace elsewhere={data} />
    ) : data === PROJECT_MISSING ? (
      <AppShell projectMissing>
        <NotFound
          action={
            <Button nativeButton={false} render={<Link to="/projects" />} size="sm" variant="outline">
              All projects
            </Button>
          }
          description="This project does not exist in your workspace, or it was deleted. Pick another project."
          title="Project not found"
        />
      </AppShell>
    ) : (
      <NotFound />
    ),
  component: ProjectLayout,
});

const isElsewhere = (data: unknown): data is ProjectElsewhere => (data as ProjectElsewhere | null)?.kind === 'project-elsewhere';

/**
 * A link to a project in another of the person's workspaces (#1): say where it is and switch only when asked. The switch
 * stays on this URL, search included; if it fails, the page says so and stays.
 */
function ProjectInOtherWorkspace({ elsewhere }: { elsewhere: ProjectElsewhere }) {
  const { workspace } = Route.useRouteContext();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const switchWorkspace = async () => {
    setSwitching(true);
    setFailed(null);
    try {
      await authCall(authClient.organization.setActive({ organizationId: elsewhere.workspaceId }));
    } catch (error) {
      setFailed(errorMessage(error));
      setSwitching(false);
      return;
    }
    // Everything cached belongs to the workspace just left; the same URL then loads again in the new one.
    queryClient.clear();
    await router.invalidate();
  };
  return (
    <AppShell projectMissing>
      <NotFound
        action={
          <div className="flex flex-col items-center gap-3">
            <div className="flex flex-wrap justify-center gap-2">
              <Button data-testid="switch-to-project-workspace" disabled={switching} onClick={switchWorkspace} size="sm">
                {switching ? <Loader2Icon className="animate-spin" /> : null}
                Switch workspace
              </Button>
              <Button nativeButton={false} render={<Link to="/projects" />} size="sm" variant="outline">
                All projects
              </Button>
            </div>
            {failed ? (
              <p className="max-w-sm text-center text-destructive text-sm" data-testid="switch-failed" role="alert">
                Could not switch to {elsewhere.workspaceName}: {failed}
              </p>
            ) : null}
          </div>
        }
        description={`You are a member of ${elsewhere.workspaceName}, but ${workspace.name} is the workspace open now. Switch to open this project; the link stays the same.`}
        title={`This project is in ${elsewhere.workspaceName}`}
      />
    </AppShell>
  );
}

function ProjectLayout() {
  const { projectId } = Route.useParams();
  useEffect(() => rememberProject(projectId), [projectId]);
  return (
    <AppShell projectId={projectId}>
      <Outlet />
    </AppShell>
  );
}
