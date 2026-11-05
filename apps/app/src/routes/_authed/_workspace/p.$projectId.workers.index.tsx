import { createFileRoute } from '@tanstack/react-router';
import { entitySortSchema } from '@trailmark/contracts';
import { z } from 'zod';
import { EntityDirectory } from '@/components/entities/entity-directory';
import { entityListQuery } from '@/lib/api/queries';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/workers/')({
  validateSearch: z.object({ q: z.string().optional(), type: z.string().optional(), sort: entitySortSchema.optional().catch(undefined) }),
  staticData: { crumb: 'Executors' },
  loaderDeps: ({ search }) => ({ q: search.q ?? '', type: search.type, sort: search.sort }),
  loader: ({ context, params, deps }) => {
    context.queryClient.prefetchInfiniteQuery(entityListQuery(params.projectId, 'executor', deps.q, deps.type, deps.sort));
  },
  head: () => ({ meta: [{ title: 'Executors · Trailmark' }] }),
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
      sort={search.sort}
      section="workers"
      type={search.type}
    />
  );
}
