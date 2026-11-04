import { useDebouncedValue } from '@tanstack/react-pacer';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Entity } from '@trailmark/contracts';
import { TypePill } from '@trailmark/ui/components/badges';
import { EntityAvatar } from '@trailmark/ui/components/entity-chip';
import { EmptyState, ErrorState } from '@trailmark/ui/components/states';
import { Button } from '@trailmark/ui/components/ui/button';
import { Input } from '@trailmark/ui/components/ui/input';
import { Skeleton } from '@trailmark/ui/components/ui/skeleton';
import { cn } from '@trailmark/ui/lib/utils';
import { Loader2Icon, SearchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { entityListQuery, facetQuery } from '@/lib/api/queries';
import { ENTITY_SECTIONS, type EntitySection, splitTargetId, typeIcon } from '@/lib/entities';
import { formatCompact, formatDate, formatRelative } from '@/lib/format';
import { placeholderKeys } from '@/lib/placeholders';

const TYPE_FACET = { actor: 'actor.type', executor: 'executor.type', target: 'target.type', tenant: null } as const;

interface EntityDirectoryProps {
  projectId: string;
  section: EntitySection;
  q: string;
  type?: string;
  onSearch: (patch: { q?: string; type?: string }) => void;
}

export function EntityDirectory({ projectId, section, q, type, onSearch }: EntityDirectoryProps) {
  const meta = ENTITY_SECTIONS[section];
  const [draft, setDraft] = useState(q);
  const [debounced] = useDebouncedValue(draft, { wait: 250 });
  useEffect(() => setDraft(q), [q]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: push the debounced search into the URL only when it changes
  useEffect(() => {
    if (debounced !== q) onSearch({ q: debounced || undefined });
  }, [debounced]);

  const list = useInfiniteQuery(entityListQuery(projectId, meta.kind, q, type));
  const typeField = TYPE_FACET[meta.kind];
  const types = useQuery({ ...facetQuery(projectId, typeField ?? 'action', '90d', '', 12), enabled: Boolean(typeField) });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 font-semibold text-xl tracking-tight">
          <meta.icon className="size-5 text-muted-foreground" />
          {meta.label}
        </h1>
        <p className="text-muted-foreground text-sm">{meta.blurb}</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-sm">
          <SearchIcon className="-translate-y-1/2 pointer-events-none absolute start-3 top-1/2 size-4 text-muted-foreground" />
          <Input
            aria-label={`Search ${meta.label.toLowerCase()}`}
            className="ps-9"
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search by name or id…"
            value={draft}
          />
          {list.isFetching && !list.isFetchingNextPage ? (
            <Loader2Icon className="-translate-y-1/2 absolute end-3 top-1/2 size-4 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        {typeField && (types.data?.values.length ?? 0) > 1 ? (
          <fieldset className="flex flex-wrap items-center gap-1.5">
            <legend className="sr-only">Filter by type</legend>
            <TypeChip active={!type} label="All" onClick={() => onSearch({ type: undefined })} />
            {types.data?.values.map((t) => (
              <TypeChip
                active={type === t.value}
                key={t.value}
                label={t.value}
                onClick={() => onSearch({ type: type === t.value ? undefined : t.value })}
              />
            ))}
          </fieldset>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_100px_90px_120px_120px] items-center gap-3 border-b bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground uppercase tracking-wider md:grid">
          <span>Name</span>
          <span>Id</span>
          <span>Type</span>
          <span className="text-end">Events</span>
          <span>First seen</span>
          <span>Last seen</span>
        </div>
        {list.isPending ? (
          <div className="flex flex-col gap-1 p-2">
            {placeholderKeys(10).map((k) => (
              <Skeleton className="h-10 w-full" key={k} />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} title={`Could not load ${meta.label.toLowerCase()}`} />
        ) : rows.length === 0 ? (
          <EmptyState
            description={
              q || type ? 'Nothing matches that search. Try a shorter name or id.' : `${meta.label} appear here as soon as events mention them.`
            }
            icon={meta.icon}
            title={q || type ? 'No matches' : `No ${meta.label.toLowerCase()} yet`}
          >
            {q || type ? (
              <Button onClick={() => onSearch({ q: undefined, type: undefined })} size="sm" variant="outline">
                Clear search
              </Button>
            ) : null}
          </EmptyState>
        ) : (
          <ul className="divide-y">
            {rows.map((e) => (
              <EntityRow entity={e} key={e.id} projectId={projectId} section={section} />
            ))}
          </ul>
        )}
        {list.hasNextPage ? (
          <div className="flex justify-center border-t p-2">
            <Button disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()} size="sm" variant="ghost">
              {list.isFetchingNextPage ? <Loader2Icon className="animate-spin" /> : null}
              Load more
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TypeChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        'h-7 rounded-md border px-2 font-mono text-[12px] outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50',
        active ? 'border-brand bg-brand/10 text-brand' : 'text-muted-foreground',
      )}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function EntityRow({ entity: e, projectId, section }: { entity: Entity; projectId: string; section: EntitySection }) {
  const displayId = e.kind === 'target' ? splitTargetId(e.id).id : e.id;
  const showIcon = !(e.kind === 'actor' && (e.type === 'user' || e.type === 'anonymous'));
  return (
    <li>
      <Link
        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/50 md:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_100px_90px_120px_120px]"
        params={{ projectId, entityId: e.id }}
        to={`/p/$projectId/${section}/$entityId` as '/p/$projectId/actors/$entityId'}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <EntityAvatar
            icon={showIcon ? typeIcon(e.kind, e.type) : undefined}
            id={e.id}
            name={e.name || e.id}
            size="md"
            square={e.kind !== 'actor'}
          />
          <span className="truncate font-medium">{e.name || displayId}</span>
        </span>
        <span className="truncate font-mono text-[12px] text-muted-foreground max-md:col-start-1 max-md:ps-9.5">{displayId}</span>
        <span className="hidden md:block">{e.type ? <TypePill>{e.type}</TypePill> : <span className="text-muted-foreground">—</span>}</span>
        <span className="text-end text-muted-foreground tabular-nums max-md:col-start-2 max-md:row-start-1">{formatCompact(e.events)}</span>
        <span className="hidden text-muted-foreground text-xs md:block">{formatDate(e.firstSeen)}</span>
        <span className="hidden text-muted-foreground text-xs md:block">{formatRelative(e.lastSeen)}</span>
      </Link>
    </li>
  );
}
