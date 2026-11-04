import { createFileRoute, notFound, Outlet, retainSearchParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { z } from 'zod';
import { NotFound } from '@/components/not-found';
import { PageSkeleton } from '@/components/route-states';
import { AppShell } from '@/components/shell/app-shell';
import { ApiRequestError } from '@/lib/api/errors';
import { projectQuery, projectsQuery, viewsQuery } from '@/lib/api/queries';
import { rememberProject } from '@/lib/session';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId')({
  validateSearch: z.object({ range: z.string().optional() }),
  search: { middlewares: [retainSearchParams(['range'])] },
  loader: async ({ context, params }) => {
    try {
      const [project] = await Promise.all([
        context.queryClient.ensureQueryData(projectQuery(params.projectId)),
        context.queryClient.ensureQueryData(projectsQuery()),
      ]);
      context.queryClient.prefetchQuery(viewsQuery(params.projectId));
      return { project };
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) throw notFound();
      throw error;
    }
  },
  head: ({ loaderData }) => ({ meta: [{ title: loaderData ? `${loaderData.project.name} · Trailmark` : 'Trailmark' }] }),
  pendingComponent: () => (
    <AppShell>
      <PageSkeleton />
    </AppShell>
  ),
  notFoundComponent: () => <NotFound description="This project does not exist in your workspace, or it was deleted." title="Project not found" />,
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
