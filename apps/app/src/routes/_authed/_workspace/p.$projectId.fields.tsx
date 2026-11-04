import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { TypePill } from '@trailmark/ui/components/badges';
import { Panel } from '@trailmark/ui/components/page-header';
import { EmptyState, ErrorState } from '@trailmark/ui/components/states';
import { Input } from '@trailmark/ui/components/ui/input';
import { SegmentedControl, SegmentedControlItem } from '@trailmark/ui/components/ui/segmented-control';
import { Skeleton } from '@trailmark/ui/components/ui/skeleton';
import { cn } from '@trailmark/ui/lib/utils';
import { CheckIcon, ListTreeIcon, SearchIcon, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { fieldsQuery } from '@/lib/api/queries';
import { formatCompact, formatPercent, formatRelative } from '@/lib/format';
import { placeholderKeys } from '@/lib/placeholders';
import { DEFAULT_RANGE, isValidRange, rangeLabel } from '@/lib/range';
import { useRange } from '@/lib/use-range';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/fields')({
  validateSearch: z.object({ kind: z.enum(['all', 'core', 'attribute']).optional() }),
  staticData: { crumb: 'Fields', range: true },
  loaderDeps: ({ search }) => ({ range: search.range }),
  loader: ({ context, params, deps }) => {
    context.queryClient.prefetchQuery(fieldsQuery(params.projectId, deps.range && isValidRange(deps.range) ? deps.range : DEFAULT_RANGE));
  },
  head: () => ({ meta: [{ title: 'Fields · Trailmark' }] }),
  component: FieldsPage,
});

/** The envelope checks behind the conformance score (docs/SPEC.md §3). */
const CONFORMANCE_CHECKS = [
  ['occurredAt', 'When it happened, not when we received it'],
  ['actor.id', 'Who caused it'],
  ['actor.type', 'user · service · system · api_key'],
  ['outcome', 'success · failure · denied · partial'],
  ['targets', 'At least one record it touched'],
  ['tenant.id', 'Which customer account'],
  ['executor.type', 'api · worker · scheduler · webhook'],
  ['context.operationId', 'or requestId — to group a request with its jobs'],
  ['description', 'A human sentence'],
] as const;

/** Map a field key to an explorer query that finds events carrying it. */
function presenceQuery(key: string): string | null {
  if (key.startsWith('attr.')) return `${key}:*`;
  const map: Record<string, string> = {
    'actor.id': 'actor:*',
    'actor.type': 'actor.type:*',
    'tenant.id': 'tenant:*',
    'executor.type': 'executor.type:*',
    'executor.id': 'executor:*',
    source: 'source:*',
    'context.operationId': 'operation:*',
    'context.requestId': 'request:*',
    'context.traceId': 'trace:*',
    'impersonator.id': 'impersonator:*',
  };
  return map[key] ?? null;
}

function FieldsPage() {
  const { projectId } = Route.useParams();
  const { kind = 'all' } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { range } = useRange();
  const fields = useQuery(fieldsQuery(projectId, range));
  const [filter, setFilter] = useState('');

  const rows = useMemo(
    () =>
      (fields.data?.data ?? []).filter((f) => (kind === 'all' || f.kind === kind) && (!filter || f.key.toLowerCase().includes(filter.toLowerCase()))),
    [fields.data, kind, filter],
  );
  const coverage = new Map((fields.data?.data ?? []).map((f) => [f.key, f.coverage]));
  const avg = fields.data?.avgConformance ?? 0;

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-semibold text-xl tracking-tight">Fields</h1>
        <p className="text-muted-foreground text-sm">
          Every field Trailmark has seen in {rangeLabel(range).toLowerCase()}: recommended envelope fields and the attributes you send on top.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_360px]">
        <Panel title="Conformance">
          <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
            <div className="relative size-28 shrink-0">
              <svg aria-hidden className="-rotate-90 size-full" viewBox="0 0 36 36">
                <circle className="stroke-muted" cx="18" cy="18" fill="none" r="15.5" strokeWidth="3.5" />
                <circle
                  className="stroke-brand transition-[stroke-dasharray]"
                  cx="18"
                  cy="18"
                  fill="none"
                  r="15.5"
                  strokeDasharray={`${(avg / 100) * 97.4} 97.4`}
                  strokeLinecap="round"
                  strokeWidth="3.5"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-semibold text-2xl tabular-nums">{fields.isPending ? '—' : Math.round(avg)}%</span>
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">average</span>
              </div>
            </div>
            <div className="flex flex-col gap-2 text-sm">
              <p>
                Conformance is the share of the <span className="font-medium">nine recommended envelope fields</span> an event carries. Nothing is
                ever rejected for a low score — it just tells you where instrumentation can improve.
              </p>
              <p className="text-muted-foreground">
                Off-standard events still land: unknown keys become searchable <span className="font-mono text-foreground">attr.*</span> fields.{' '}
                <Link className="text-foreground underline underline-offset-2" params={{ projectId }} to="/p/$projectId/docs">
                  Recommended envelope →
                </Link>
              </p>
            </div>
          </div>
        </Panel>
        <Panel title="Recommended fields">
          <ul className="flex flex-col p-2">
            {CONFORMANCE_CHECKS.map(([key, hint]) => {
              const c = key === 'targets' ? coverage.get('targets') : key === 'occurredAt' ? 1 : coverage.get(key);
              const good = (c ?? 0) >= 0.9;
              return (
                <li className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px]" key={key} title={hint}>
                  {good ? (
                    <CheckIcon className="size-3.5 shrink-0 text-outcome-success" />
                  ) : (
                    <XIcon className="size-3.5 shrink-0 text-outcome-denied" />
                  )}
                  <span className="font-mono text-[12px]">{key}</span>
                  <span className="hidden min-w-0 flex-1 truncate text-muted-foreground text-xs sm:inline">{hint}</span>
                  <span className="ms-auto shrink-0 text-muted-foreground text-xs tabular-nums">
                    {fields.isPending ? '—' : formatPercent(c ?? 0)}
                  </span>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl aria-label="Field kind" density="compact">
          {(
            [
              ['all', 'All'],
              ['core', 'Envelope'],
              ['attribute', 'Attributes'],
            ] as const
          ).map(([value, label]) => (
            <SegmentedControlItem
              active={kind === value}
              key={value}
              onClick={() => navigate({ search: (prev) => ({ ...prev, kind: value }), replace: true })}
            >
              {label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <div className="relative w-full sm:max-w-xs">
          <SearchIcon className="-translate-y-1/2 pointer-events-none absolute start-3 top-1/2 size-4 text-muted-foreground" />
          <Input
            aria-label="Filter fields"
            className="ps-9"
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter fields…"
            value={filter}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
        <div className="hidden grid-cols-[minmax(0,1.3fr)_90px_minmax(0,1fr)_80px_minmax(0,1.6fr)_100px] gap-3 border-b bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground uppercase tracking-wider md:grid">
          <span>Field</span>
          <span>Kind</span>
          <span>Coverage</span>
          <span className="text-end">Distinct</span>
          <span>Samples</span>
          <span>Last seen</span>
        </div>
        {fields.isPending ? (
          <div className="flex flex-col gap-1 p-2">
            {placeholderKeys(12).map((k) => (
              <Skeleton className="h-9" key={k} />
            ))}
          </div>
        ) : fields.isError ? (
          <ErrorState error={fields.error} onRetry={() => fields.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            description={filter ? 'No field matches that filter.' : 'Fields appear once events arrive in this range.'}
            icon={ListTreeIcon}
            title="No fields"
          />
        ) : (
          <ul className="divide-y">
            {rows.map((f) => {
              const q = presenceQuery(f.key);
              return (
                <li
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px] md:grid-cols-[minmax(0,1.3fr)_90px_minmax(0,1fr)_80px_minmax(0,1.6fr)_100px]"
                  key={f.key}
                >
                  {q ? (
                    <Link
                      className="truncate font-mono text-[12.5px] hover:underline"
                      params={{ projectId }}
                      search={(prev) => ({ range: prev.range, q })}
                      to="/p/$projectId/events"
                    >
                      {f.key}
                    </Link>
                  ) : (
                    <span className="truncate font-mono text-[12.5px]">{f.key}</span>
                  )}
                  <span>
                    <TypePill tone={f.kind === 'core' ? 'brand' : 'neutral'}>{f.kind === 'core' ? 'envelope' : 'attribute'}</TypePill>
                  </span>
                  <span className="flex items-center gap-2 max-md:col-span-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className={cn(
                          'block h-full rounded-full',
                          f.coverage >= 0.9 ? 'bg-outcome-success' : f.coverage >= 0.5 ? 'bg-brand' : 'bg-outcome-denied',
                        )}
                        style={{ width: `${f.coverage * 100}%` }}
                      />
                    </span>
                    <span className="w-12 text-end text-muted-foreground text-xs tabular-nums">{formatPercent(f.coverage)}</span>
                  </span>
                  <span className="hidden text-end text-muted-foreground tabular-nums md:block">{formatCompact(f.distinctApprox)}</span>
                  <span className="hidden min-w-0 gap-1 overflow-hidden md:flex">
                    {f.samples.slice(0, 3).map((s) => (
                      <span
                        className="max-w-40 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                        key={s}
                        title={s}
                      >
                        {s}
                      </span>
                    ))}
                  </span>
                  <span className="hidden text-muted-foreground text-xs md:block">{formatRelative(f.lastSeen)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
