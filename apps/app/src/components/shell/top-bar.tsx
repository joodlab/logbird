import { useQuery } from '@tanstack/react-query';
import { Link, useMatches, useParams } from '@tanstack/react-router';
import { TimeRangePicker } from '@trailmark/ui/components/time-range-picker';
import { Kbd } from '@trailmark/ui/components/ui/kbd';
import { Separator } from '@trailmark/ui/components/ui/separator';
import { SidebarTrigger } from '@trailmark/ui/components/ui/sidebar';
import { ChevronRightIcon, SearchIcon } from 'lucide-react';
import { useMemo } from 'react';
import { projectQuery } from '@/lib/api/queries';
import { useCrumb } from '@/lib/crumbs';
import { absoluteRange, RANGE_PRESETS, rangeLabel, rangeShortLabel, resolveRange } from '@/lib/range';
import { useRange } from '@/lib/use-range';

export function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const matches = useMatches();
  const params = useParams({ strict: false }) as { projectId?: string };
  const project = useQuery({ ...projectQuery(params.projectId ?? ''), enabled: Boolean(params.projectId) });
  const dynamicCrumb = useCrumb();
  const { range, setRange } = useRange();
  const resolved = useMemo(() => {
    const r = resolveRange(range);
    return { from: new Date(r.fromMs), to: new Date(r.toMs) };
  }, [range]);

  const sections = matches.filter((m) => m.staticData?.crumb).map((m) => ({ id: m.id, label: m.staticData.crumb as string, path: m.pathname }));
  const showRange = matches.some((m) => m.staticData?.range);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <header className="relative z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
      <SidebarTrigger className="-ms-1 text-muted-foreground" />
      <Separator className="me-1 h-4 data-[orientation=vertical]:self-center" orientation="vertical" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-sm">
        {params.projectId ? (
          <Link
            className="hidden max-w-40 truncate text-muted-foreground hover:text-foreground sm:block"
            params={{ projectId: params.projectId }}
            to="/p/$projectId"
          >
            {project.data?.name ?? '…'}
          </Link>
        ) : null}
        {sections.map((s, i) => {
          const last = i === sections.length - 1 && !dynamicCrumb;
          return (
            <span className="flex min-w-0 items-center gap-1" key={s.id}>
              {i === 0 && !params.projectId ? null : (
                <ChevronRightIcon
                  className={i === 0 ? 'hidden size-3.5 shrink-0 text-muted-foreground/60 sm:block' : 'size-3.5 shrink-0 text-muted-foreground/60'}
                />
              )}
              {last ? (
                <span aria-current="page" className="truncate font-medium">
                  {s.label}
                </span>
              ) : (
                <Link
                  className="truncate text-muted-foreground hover:text-foreground"
                  to={dynamicCrumb && i === sections.length - 1 ? s.path.replace(/\/[^/]+\/?$/, '') : s.path}
                >
                  {s.label}
                </Link>
              )}
            </span>
          );
        })}
        {dynamicCrumb ? (
          <span className="flex min-w-0 items-center gap-1">
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
            <span aria-current="page" className="truncate font-medium">
              {dynamicCrumb}
            </span>
          </span>
        ) : null}
      </nav>
      <div className="flex shrink-0 items-center gap-2">
        {showRange ? (
          <TimeRangePicker
            className="w-auto max-w-[min(60vw,15rem)]"
            label={typeof window !== 'undefined' && window.innerWidth < 640 ? rangeShortLabel(range) : rangeLabel(range)}
            onChange={setRange}
            presets={RANGE_PRESETS}
            resolved={resolved}
            toAbsolute={(from, to) => absoluteRange(from.getTime(), to.getTime())}
            value={range}
          />
        ) : null}
        <button
          aria-label="Open command palette"
          className="flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-muted-foreground text-sm shadow-xs outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 sm:w-52 sm:px-2.5 dark:bg-input/30"
          onClick={onOpenPalette}
          type="button"
        >
          <SearchIcon className="size-3.5" />
          <span className="hidden flex-1 text-start sm:inline">Jump to…</span>
          <Kbd className="hidden sm:inline-flex">{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
        </button>
      </div>
    </header>
  );
}
