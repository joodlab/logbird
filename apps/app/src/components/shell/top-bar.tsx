import { TimeRangePicker } from '@logbird/ui/components/time-range-picker';
import { Button } from '@logbird/ui/components/ui/button';
import { Kbd } from '@logbird/ui/components/ui/kbd';
import { Separator } from '@logbird/ui/components/ui/separator';
import { SidebarTrigger } from '@logbird/ui/components/ui/sidebar';
import { cn } from '@logbird/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { Link, useMatches, useParams } from '@tanstack/react-router';
import { ChevronRightIcon, SearchIcon } from 'lucide-react';
import { useMemo } from 'react';
import { projectsQuery } from '@/lib/api/queries';
import { useCrumb } from '@/lib/crumbs';
import { zoneOffsetMs } from '@/lib/format';
import { modKeyLabel, useIsMac } from '@/lib/platform';
import { absoluteRange, RANGE_PRESETS, rangeLabel, rangeShortLabel, resolveRange } from '@/lib/range';
import { useConsoleZone } from '@/lib/time-zone';
import { useRange } from '@/lib/use-range';

export function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  // Range labels and the custom range editor follow the console zone; re-render when the reader switches it.
  const zone = useConsoleZone();
  const pickerZone = useMemo(() => ({ offsetMs: zoneOffsetMs, label: zone }), [zone]);
  const matches = useMatches();
  const params = useParams({ strict: false }) as { projectId?: string };
  // The project's name comes from the workspace's project list (the sidebar reads it too), never a fetch by id: a
  // project the list does not hold (a stale link on its not-found page) gets no crumb and no request answering 404.
  const projects = useQuery(projectsQuery());
  const listed = projects.data?.find((p) => p.id === params.projectId);
  const projectId = params.projectId && (!projects.isSuccess || listed) ? params.projectId : undefined;
  const dynamicCrumb = useCrumb();
  const { range, setRange, wholeHistory } = useRange();
  const resolved = useMemo(() => {
    const r = resolveRange(range);
    return { from: new Date(r.fromMs), to: new Date(r.toMs) };
  }, [range]);

  const sections = (params.projectId && !projectId ? [] : matches)
    .filter((m) => m.staticData?.crumb)
    .map((m) => ({
      id: m.id,
      label: m.staticData.crumb as string,
      path: m.pathname,
      to: m.staticData.crumbTo && projectId ? m.staticData.crumbTo.replace('$projectId', projectId) : undefined,
      search: m.staticData.crumbSearch,
    }));
  // A project that is not found has no range to pick.
  const showRange = !(params.projectId && !projectId) && matches.some((m) => m.staticData?.range);
  const isMac = useIsMac();

  return (
    <header className="relative z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
      <SidebarTrigger className="-ms-1 text-muted-foreground" />
      <Separator className="me-1 h-4 data-[orientation=vertical]:self-center" orientation="vertical" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-sm">
        {projectId ? (
          <Link
            className="-my-3 hidden max-w-40 truncate py-3 text-muted-foreground hover:text-foreground sm:block"
            params={{ projectId }}
            to="/p/$projectId"
          >
            {listed?.name ?? '…'}
          </Link>
        ) : null}
        {sections.map((s, i) => {
          const last = i === sections.length - 1 && !dynamicCrumb;
          return (
            // Section crumbs ("Actors", "Settings") stay whole; only the page's own name truncates. On a phone only the
            // page's own name shows: a section cut to "R…" helps nobody, and the sidebar is one tap away.
            <span className={cn('flex min-w-0 items-center gap-1', !last && 'shrink-0 max-sm:hidden')} key={s.id}>
              {i === 0 && !projectId ? null : <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60 max-sm:hidden" />}
              {last ? (
                <span aria-current="page" className="truncate font-medium">
                  {s.label}
                </span>
              ) : (
                <Link
                  className="-my-3 truncate py-3 text-muted-foreground hover:text-foreground"
                  to={s.to ?? (dynamicCrumb && i === sections.length - 1 ? s.path.replace(/\/[^/]+\/?$/, '') : s.path)}
                  search={s.search ? (prev: { range?: string }) => ({ range: prev.range, ...s.search }) : undefined}
                >
                  {s.label}
                </Link>
              )}
            </span>
          );
        })}
        {dynamicCrumb ? (
          <span className="flex min-w-0 items-center gap-1">
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60 max-sm:hidden" />
            <span aria-current="page" className="truncate font-medium">
              {dynamicCrumb}
            </span>
          </span>
        ) : null}
      </nav>
      <div className="flex shrink-0 items-center gap-2">
        {showRange ? (
          <TimeRangePicker
            className="w-auto max-w-[min(60vw,15rem)] md:max-w-48 lg:max-w-[min(40vw,28rem)]"
            // An entity page with no range chosen shows its whole History; the range scopes only the summary (stats,
            // support split, activity chart). The picker says so; picking a range narrows the History too.
            label={rangeButtonLabel(range, wholeHistory, typeof window !== 'undefined' && window.innerWidth < 640)}
            onChange={setRange}
            presets={RANGE_PRESETS}
            resolved={resolved}
            toAbsolute={(from, to) => absoluteRange(from.getTime(), to.getTime())}
            value={range}
            zone={pickerZone}
          />
        ) : null}
        <Button
          aria-label="Open command palette"
          className="w-(--control-size-compact) justify-start gap-2 px-0 font-normal text-muted-foreground max-sm:justify-center sm:w-40 sm:px-2.5 sm:pe-1.5 lg:w-52"
          onClick={onOpenPalette}
          size="sm"
          variant="outline"
        >
          <SearchIcon />
          <span className="hidden flex-1 text-start sm:inline">Jump to…</span>
          <Kbd className="hidden sm:inline-flex">{modKeyLabel(isMac, 'K')}</Kbd>
        </Button>
      </div>
    </header>
  );
}

/** The picker's label: "Last 24 hours", or "Summary: Last 24 hours" on an entity page whose History shows everything. */
export function rangeButtonLabel(range: string, wholeHistory: boolean, phone: boolean): string {
  const label = phone ? rangeShortLabel(range) : rangeLabel(range);
  return wholeHistory ? `Summary: ${label}` : label;
}
