import { createFileRoute } from '@tanstack/react-router';
import { useCallback } from 'react';
import { z } from 'zod';
import { SupportAgentProfile } from '@/components/entities/support-agent-profile';
import { DEFAULT_COLUMNS } from '@/components/explorer/columns';
import type { ExplorerState } from '@/components/explorer/explorer';
import { useRange } from '@/lib/use-range';

/** A support agent's page: everything they did while impersonating customers (`impersonator:<id>`). */
export const Route = createFileRoute('/_authed/_workspace/p/$projectId/support/$agentId')({
  head: () => ({ meta: [{ title: 'Support agent · Logbird' }] }),
  validateSearch: z.object({ q: z.string().optional(), ev: z.string().optional(), live: z.boolean().optional() }),
  // Support sessions are rare: open on a range that usually has some.
  staticData: { crumb: 'Actors', crumbTo: '/p/$projectId/actors', range: true, defaultRange: '30d' },
  component: SupportAgentPage,
});

function SupportAgentPage() {
  const { projectId, agentId } = Route.useParams();
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
          ...('range' in patch ? { range: patch.range === '30d' ? undefined : patch.range } : {}),
        }),
      }),
    [navigate],
  );
  return (
    <SupportAgentProfile
      agentId={agentId}
      onTimelineChange={onChange}
      projectId={projectId}
      timeline={{ q: search.q ?? '', range, columns: DEFAULT_COLUMNS, ev: search.ev, live: Boolean(search.live) }}
    />
  );
}
