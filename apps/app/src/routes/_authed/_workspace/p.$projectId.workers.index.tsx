import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { EntityDirectory } from '@/components/entities/entity-directory';
import { entityListQuery } from '@/lib/api/queries';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/workers/')({
  validateSearch: z.object({ q: z.string().optional(), type: z.string().optional() }),
  staticData: { crumb: 'Workers' },
  loaderDeps: ({ search }) => ({ q: search.q ?? '', type: search.type }),
  loader: ({ context, params, deps }) => {
    context.queryClient.prefetchInfiniteQuery(entityListQuery(params.projectId, 'executor', deps.q, deps.type));
  },
  head: () => ({ meta: [{ title: 'Workers · Trailmark' }] }),
  component: DirectoryPage,
});

function DirectoryPage() {
  const { projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <EntityDirectory
      onSearch={(patch) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })}
      projectId={projectId}
      q={search.q ?? ''}
      section="workers"
      type={search.type}
    />
  );
}
