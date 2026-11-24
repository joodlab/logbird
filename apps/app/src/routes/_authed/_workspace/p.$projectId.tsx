import { Button } from '@logbird/ui/components/ui/button';
import { createFileRoute, Link, notFound, Outlet, retainSearchParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { z } from 'zod';
import { NotFound } from '@/components/not-found';
import { PageSkeleton } from '@/components/route-states';
import { AppShell } from '@/components/shell/app-shell';
import { ApiRequestError } from '@/lib/api/errors';
import { projectQuery, projectsQuery, viewsQuery } from '@/lib/api/queries';
import { PROJECT_MISSING, projectIsListed } from '@/lib/project-listed';
import { redirectIfWorkspaceLost, rememberProject } from '@/lib/session';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId')({
  // A shared URL can carry `range=0` or `range=true`, which the router decodes as a number or boolean: drop it, so the page
  // falls back to its default range instead of failing validation.
  validateSearch: z.object({ range: z.string().optional().catch(undefined) }),
  search: { middlewares: [retainSearchParams(['range'])] },
  // A project this workspace does not list (deleted, another workspace's, a stale bookmark) is not found before any of
  // its requests runs: the loader and the page's own queries would each answer 404 into the console. A project the
  // cached list lacks is checked against a fresh list first, so one created since is never shown as not found.
  beforeLoad: async ({ context, params }) => {
    if (!(await projectIsListed(context.queryClient, params.projectId))) throw notFound({ data: PROJECT_MISSING });
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
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) {
        await redirectIfWorkspaceLost(context.queryClient);
        throw notFound({ data: PROJECT_MISSING });
      }
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
    data === PROJECT_MISSING ? (
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

function ProjectLayout() {
  const { projectId } = Route.useParams();
  useEffect(() => rememberProject(projectId), [projectId]);
  return (
    <AppShell projectId={projectId}>
      <Outlet />
    </AppShell>
  );
}
