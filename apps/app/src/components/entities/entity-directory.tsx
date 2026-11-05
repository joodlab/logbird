import { useDebouncedValue } from '@tanstack/react-pacer';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Entity, EntitySort } from '@trailmark/contracts';
import { TypePill } from '@trailmark/ui/components/badges';
import { CodeBlock } from '@trailmark/ui/components/code-block';
import { EntityAvatar } from '@trailmark/ui/components/entity-chip';
import { EmptyState, ErrorState } from '@trailmark/ui/components/states';
import { Button, buttonVariants } from '@trailmark/ui/components/ui/button';
import { Input } from '@trailmark/ui/components/ui/input';
import { SegmentedControl, SegmentedControlItem } from '@trailmark/ui/components/ui/segmented-control';
import { Skeleton } from '@trailmark/ui/components/ui/skeleton';
import { cn } from '@trailmark/ui/lib/utils';
import { BookOpenIcon, Loader2Icon, SearchIcon, SearchXIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Timestamp } from '@/components/timestamp';
import { entityListQuery, facetQuery } from '@/lib/api/queries';
import { ENTITY_SECTIONS, type EntitySection, splitTargetId, typeIcon } from '@/lib/entities';
import { formatCompact } from '@/lib/format';
import { placeholderKeys } from '@/lib/placeholders';

const TYPE_FACET = { actor: 'actor.type', executor: 'executor.type', target: 'target.type', tenant: null } as const;
/** Never-populated state: what the page is for and which envelope field fills it. */
const EMPTY_EXPLAINERS: Record<EntitySection, { lead: ReactNode; snippet: string; note?: ReactNode }> = {
  actors: {
    lead: (
      <>
        Send <Code>{'actor: { type, id, name }'}</Code> on your events.
      </>
    ),
    snippet: '"actor": { "type": "user", "id": "usr_42", "name": "Raed" }',
    note: (
      <>
        Scheduled jobs use <Code>type: "system"</Code>.
      </>
    ),
  },
  tenants: {
    lead: (
      <>
        Send <Code>{'tenant: { id, name }'}</Code> so you can answer “what happened in this customer’s account?”.
      </>
    ),
    snippet: '"tenant": { "id": "biz_7", "name": "Azure Hotels" }',
  },
  workers: {
    lead: (
      <>
        Send <Code>{'executor: { type, id, name, jobId, attempt }'}</Code>.
      </>
    ),
    snippet: [
      '"executor": {',
      '  "type": "worker", "id": "refunds-worker",',
      '  "name": "Refunds worker", "jobId": "job_981", "attempt": 2',
      '}',
    ].join('\n'),
    note: 'The actor is who asked; the executor is what did the work.',
  },
  records: {
    lead: (
      <>
        Send <Code>{'targets: [{ type, id, name }]'}</Code> — one entry per record the action touched.
      </>
    ),
    snippet: ['"targets": [', '  { "type": "booking", "id": "bk_1042", "name": "Booking #1042" }', ']'].join('\n'),
  },
};

const SORTS: { value: EntitySort; label: string; title: string }[] = [
  { value: 'events', label: 'Most active', title: 'Most events first, then most recently seen' },
  { value: 'lastSeen', label: 'Recently seen', title: 'Most recently seen first' },
  { value: 'name', label: 'Name', title: 'Alphabetical by name' },
];

interface EntityDirectoryProps {
  projectId: string;
  section: EntitySection;
  q: string;
  type?: string;
  /** Omitted = most active (the server default). */
  sort?: EntitySort;
  onSearch: (patch: { q?: string; type?: string; sort?: EntitySort }) => void;
}

export function EntityDirectory({ projectId, section, q, type, sort = 'events', onSearch }: EntityDirectoryProps) {
  const meta = ENTITY_SECTIONS[section];
  const [draft, setDraft] = useState(q);
  const [debounced] = useDebouncedValue(draft, { wait: 250 });
  useEffect(() => setDraft(q), [q]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: push the debounced search into the URL only when it changes
  useEffect(() => {
    if (debounced !== q) onSearch({ q: debounced || undefined });
  }, [debounced]);

  const list = useInfiniteQuery(entityListQuery(projectId, meta.kind, q, type, sort));
  const typeField = TYPE_FACET[meta.kind];
  const types = useQuery({ ...facetQuery(projectId, typeField ?? 'action', '90d', '', 12), enabled: Boolean(typeField) });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];
  // Events without a type cannot be filtered by type: only offer real values.
  const typeValues = (types.data?.values ?? []).filter((t) => t.value);

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
        {typeField && typeValues.length > 1 ? (
          <fieldset className="flex flex-wrap items-center gap-1.5">
            <legend className="sr-only">Filter by type</legend>
            <TypeChip active={!type} label="All" onClick={() => onSearch({ type: undefined })} />
            {typeValues.map((t) => (
              <TypeChip
                active={type === t.value}
                count={t.count}
                key={t.value}
                label={t.value}
                onClick={() => onSearch({ type: type === t.value ? undefined : t.value })}
              />
            ))}
          </fieldset>
        ) : null}
        <SegmentedControl aria-label="Sort" className="shrink-0 self-start sm:ms-auto sm:self-auto" density="compact">
          {SORTS.map((s) => (
            <SegmentedControlItem
              active={sort === s.value}
              key={s.value}
              onClick={() => onSearch({ sort: s.value === 'events' ? undefined : s.value })}
              title={s.title}
            >
              {s.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        {list.isSuccess && rows.length === 0 ? null : (
          <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_100px_90px_120px_120px] items-center gap-3 border-b bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground uppercase tracking-wider md:grid">
            <span>Name</span>
            <span>Id</span>
            <span>Type</span>
            <span className="text-end">Events</span>
            <span>First seen</span>
            <span>Last seen</span>
          </div>
        )}
        {list.isPending ? (
          <div className="flex flex-col gap-1 p-2">
            {placeholderKeys(10).map((k) => (
              <Skeleton className="h-10 w-full" key={k} />
            ))}
          </div>
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} title={`Could not load ${meta.label.toLowerCase()}`} />
        ) : rows.length === 0 ? (
          q || type ? (
            <EmptyState description="Nothing matches that search. Try a shorter name or id." icon={SearchXIcon} size="sm" title="No matches">
              <Button onClick={() => onSearch({ q: undefined, type: undefined })} size="sm" variant="outline">
                Clear search
              </Button>
            </EmptyState>
          ) : (
            <NeverPopulated projectId={projectId} section={section} />
          )
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

function NeverPopulated({ projectId, section }: { projectId: string; section: EntitySection }) {
  const meta = ENTITY_SECTIONS[section];
  const explainer = EMPTY_EXPLAINERS[section];
  return (
    <div className="pb-10">
      <EmptyState
        className="pb-5"
        description={
          <span className="flex flex-col gap-1">
            <span>{explainer.lead}</span>
            {explainer.note ? <span>{explainer.note}</span> : null}
          </span>
        }
        icon={meta.icon}
        title={`No ${meta.label.toLowerCase()} yet`}
      />
      {/* A plain block (not a flex child of EmptyState) so the snippet's long lines scroll inside it instead of widening the card. */}
      <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-3 px-4 sm:px-6">
        <CodeBlock className="w-full text-start" code={explainer.snippet} copyLabel="Copy snippet" language="json" />
        <Link className={buttonVariants({ size: 'sm', variant: 'outline' })} hash="envelope" params={{ projectId }} to="/p/$projectId/docs">
          <BookOpenIcon />
          Read the quickstart
        </Link>
      </div>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground">{children}</code>;
}

function TypeChip({ label, active, onClick, count }: { label: string; active: boolean; onClick: () => void; count?: number }) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-md border px-2 font-mono text-[12px] outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50',
        active ? 'border-brand bg-brand/10 text-brand' : 'text-muted-foreground',
      )}
      onClick={onClick}
      type="button"
    >
      {label}
      {count === undefined ? null : <span className="font-sans text-[11px] tabular-nums opacity-70">{formatCompact(count)}</span>}
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
        <Timestamp className="hidden text-muted-foreground text-xs md:block" format="date" iso={e.firstSeen} />
        <Timestamp className="hidden text-muted-foreground text-xs md:block" format="relative" iso={e.lastSeen} />
      </Link>
    </li>
  );
}
