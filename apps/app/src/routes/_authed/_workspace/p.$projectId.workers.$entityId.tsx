import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { z } from 'zod';
import { EntityProfile } from '@/components/entities/entity-profile';
import { DEFAULT_COLUMNS } from '@/components/explorer/columns';
import type { ExplorerState } from '@/components/explorer/explorer';
import { entityProfileQuery } from '@/lib/api/queries';
import { DEFAULT_RANGE, isValidRange } from '@/lib/range';
import { useRange } from '@/lib/use-range';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/workers/$entityId')({
  validateSearch: z.object({ q: z.string().optional(), ev: z.string().optional(), live: z.boolean().optional() }),
  staticData: { crumb: 'Workers', range: true },
  loaderDeps: ({ search }) => ({ range: search.range }),
  loader: ({ context, params, deps }) => {
    const range = deps.range && isValidRange(deps.range) ? deps.range : DEFAULT_RANGE;
    context.queryClient.prefetchQuery(entityProfileQuery(params.projectId, 'executor', params.entityId, range));
  },
  component: ProfilePage,
});

function ProfilePage() {
  const { projectId, entityId } = Route.useParams();
  const search = Route.useSearch();
  const { range } = useRange();
  const navigate = Route.useNavigate();
  const onChange = useCallback(
    (patch: Partial<ExplorerState>) =>
      navigate({
        replace: Object.keys(patch).every((k) => k === 'ev'),
        search: (prev) => ({
          ...prev,
          ...('q' in patch ? { q: patch.q || undefined } : {}),
          ...('ev' in patch ? { ev: patch.ev } : {}),
          ...('live' in patch ? { live: patch.live || undefined } : {}),
          ...('range' in patch ? { range: patch.range === DEFAULT_RANGE ? undefined : patch.range } : {}),
        }),
      }),
    [navigate],
  );
  return (
    <EntityProfile
      entityId={entityId}
      onTimelineChange={onChange}
      projectId={projectId}
      section="workers"
      timeline={{ q: search.q ?? '', range, columns: DEFAULT_COLUMNS, ev: search.ev, live: Boolean(search.live) }}
    />
  );
}
