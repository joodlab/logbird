import { queryLangSchema } from '@logbird/contracts';
import { Button } from '@logbird/ui/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { BookmarkIcon, LinkIcon, XIcon } from 'lucide-react';
import { useCallback } from 'react';
import { z } from 'zod';
import { parseColumns, serializeColumns } from '@/components/explorer/columns';
import { Explorer, type ExplorerState } from '@/components/explorer/explorer';
import { SampleDataBanner } from '@/components/setup/sample-data-banner';
import { eventsInfiniteQuery, histogramQuery, viewsQuery } from '@/lib/api/queries';
import { DEFAULT_RANGE, isValidRange } from '@/lib/range';
import { useRange } from '@/lib/use-range';
import { useCopyViewLink } from '@/lib/views';

const searchSchema = z.object({
  q: z.string().optional(),
  /** `sql` = q is a SQL WHERE expression; absent = query language. */
  lang: queryLangSchema.optional().catch(undefined),
  cols: z.string().optional(),
  ev: z.string().optional(),
  live: z.boolean().optional(),
  view: z.string().optional(),
});

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/events')({
  validateSearch: searchSchema,
  staticData: { crumb: 'Explorer', range: true },
  loaderDeps: ({ search }) => ({ q: search.q ?? '', lang: search.lang ?? 'query', range: search.range }),
  loader: ({ context, params, deps }) => {
    const range = deps.range && isValidRange(deps.range) ? deps.range : DEFAULT_RANGE;
    context.queryClient.prefetchInfiniteQuery(eventsInfiniteQuery(params.projectId, range, deps.q, deps.lang));
    context.queryClient.prefetchQuery(histogramQuery(params.projectId, range, deps.q, deps.lang));
  },
  head: () => ({ meta: [{ title: 'Explorer · Logbird' }] }),
  component: ExplorerPage,
});

function ExplorerPage() {
  const { projectId } = Route.useParams();
  const search = Route.useSearch();
  const { range } = useRange();
  const navigate = useNavigate({ from: Route.fullPath });
  const views = useQuery(viewsQuery(projectId));
  const view = search.view ? views.data?.find((v) => v.id === search.view) : undefined;
  const copyLink = useCopyViewLink();

  const state: ExplorerState = {
    q: search.q ?? '',
    lang: search.lang ?? 'query',
    range,
    columns: parseColumns(search.cols),
    ev: search.ev,
    live: Boolean(search.live),
  };

  const onChange = useCallback(
    (patch: Partial<ExplorerState>) => {
      // Selecting an event replaces history; changing the query pushes so back/forward walks searches.
      const onlySelection = Object.keys(patch).every((k) => k === 'ev');
      navigate({
        replace: onlySelection,
        search: (prev) => {
          const next = { ...prev };
          if ('q' in patch) next.q = patch.q || undefined;
          if ('lang' in patch) next.lang = patch.lang === 'sql' ? 'sql' : undefined;
          if ('range' in patch) next.range = patch.range === DEFAULT_RANGE ? undefined : patch.range;
          if ('columns' in patch) next.cols = patch.columns ? serializeColumns(patch.columns) : undefined;
          if ('ev' in patch) next.ev = patch.ev;
          if ('live' in patch) next.live = patch.live || undefined;
          // A saved view stays "open" only while its query is untouched.
          const viewLang = view?.state.lang === 'sql' ? 'sql' : undefined;
          if (view && ('q' in patch || 'lang' in patch || 'range' in patch) && ((next.q ?? '') !== (view.state.q ?? '') || next.lang !== viewLang))
            next.view = undefined;
          return next;
        },
      });
    },
    [navigate, view],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-fills-viewport>
      {view ? (
        <div className="flex items-center justify-between gap-3 border-b bg-brand/[0.04] px-4 py-2 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <BookmarkIcon className="size-4 shrink-0 text-brand" />
            <span className="truncate font-medium">{view.name}</span>
            {view.description ? <span className="hidden truncate text-muted-foreground md:inline">— {view.description}</span> : null}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <Button data-testid="banner-copy-view-link" onClick={() => copyLink(projectId, view)} size="xs" variant="ghost">
              <LinkIcon />
              Copy link
            </Button>
            <Button onClick={() => navigate({ search: (prev) => ({ ...prev, view: undefined }) })} size="xs" variant="ghost">
              <XIcon />
              Close view
            </Button>
          </span>
        </div>
      ) : null}
      <SampleDataBanner className="border-b" projectId={projectId} />
      <Explorer onChange={onChange} projectId={projectId} state={state} />
    </div>
  );
}
