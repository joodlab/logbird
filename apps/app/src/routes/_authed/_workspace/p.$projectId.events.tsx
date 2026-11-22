import { queryLangSchema } from '@logbird/contracts';
import { Button } from '@logbird/ui/components/ui/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { BookmarkIcon, LinkIcon, XIcon } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { parseColumns, serializeColumns } from '@/components/explorer/columns';
import { Explorer, type ExplorerState } from '@/components/explorer/explorer';
import { SampleDataBanner } from '@/components/setup/sample-data-banner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { eventsInfiniteQuery, histogramQuery, keys, viewsQuery } from '@/lib/api/queries';
import { DEFAULT_RANGE, isValidRange } from '@/lib/range';
import { useRange } from '@/lib/use-range';
import { upgradeRecordView, useCopyViewLink } from '@/lib/views';

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
  const storedView = search.view ? views.data?.find((v) => v.id === search.view) : undefined;
  // A view saved from a record page before exact record matching opens in its exact form (viewSearch); the banner
  // says so and the reader decides whether to save it. Nothing is written on load.
  const upgrade = storedView ? upgradeRecordView(storedView) : undefined;
  // Every way into an old record-page view (sidebar, command palette, query-bar suggestions, an old shared link) carries
  // its stored query: show the exact form instead, in place, with the note below. Nothing is saved.
  const legacyQ = upgrade?.upgraded && storedView ? (storedView.state.q ?? '') : undefined;
  const upgradedQ = upgrade?.upgraded ? (upgrade.state.q ?? '') : undefined;
  useEffect(() => {
    if (legacyQ !== undefined && upgradedQ !== undefined && (search.q ?? '') === legacyQ)
      navigate({ replace: true, search: (prev) => ({ ...prev, q: upgradedQ || undefined }) });
  }, [legacyQ, upgradedQ, search.q, navigate]);
  const savedView = storedView && upgrade ? { ...storedView, state: upgrade.state } : undefined;
  // The banner (and its Copy link) speaks for the view only while what is on screen is still that view: same query,
  // language and range. Narrowing it by picker, zoom or Back hides it.
  const view =
    savedView &&
    (search.q ?? '') === (savedView.state.q ?? '') &&
    (search.lang === 'sql' ? 'sql' : 'query') === (savedView.state.lang === 'sql' ? 'sql' : 'query') &&
    range === (savedView.state.range ?? DEFAULT_RANGE)
      ? savedView
      : undefined;
  const copyLink = useCopyViewLink();
  const queryClient = useQueryClient();
  const saveUpgrade = useMutation({
    mutationFn: (v: NonNullable<typeof view>) => api.views.create(projectId, { name: v.name, description: v.description, state: v.state }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: [...keys.project(projectId), 'views'] });
      toast.success(`Saved “${created.name}” with the exact record filter`, {
        description: 'The original view is unchanged; delete it from Saved views when you no longer need it.',
      });
      navigate({ search: (prev) => ({ ...prev, view: created.id }) });
    },
    onError: (error) => toast.error('Could not save the view', { description: errorMessage(error) }),
  });

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
            {upgrade?.upgraded ? (
              <span className="truncate text-muted-foreground text-xs" data-testid="view-upgraded" role="status">
                · Changed to match this record's type and id together (saved before exact record matching), not saved yet
              </span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {upgrade?.upgraded ? (
              <Button disabled={saveUpgrade.isPending} onClick={() => saveUpgrade.mutate(view)} size="xs" variant="outline">
                <BookmarkIcon />
                Save updated view
              </Button>
            ) : null}
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
