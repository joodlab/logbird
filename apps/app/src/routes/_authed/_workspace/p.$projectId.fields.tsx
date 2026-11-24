import { TypePill } from '@logbird/ui/components/badges';
import { Panel } from '@logbird/ui/components/page-header';
import { EmptyState, ErrorState } from '@logbird/ui/components/states';
import { Input } from '@logbird/ui/components/ui/input';
import { SegmentedControl, SegmentedControlItem } from '@logbird/ui/components/ui/segmented-control';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { cn } from '@logbird/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { CheckIcon, ListTreeIcon, MinusIcon, SearchIcon, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { Timestamp } from '@/components/timestamp';
import { awaiting, current } from '@/lib/api/current';
import { fieldsQuery } from '@/lib/api/queries';
import { formatCompact, formatPercent } from '@/lib/format';
import { placeholderKeys } from '@/lib/placeholders';
import { DEFAULT_RANGE, isValidRange, rangeInSentence, rangeLabel } from '@/lib/range';
import { useConsoleZone } from '@/lib/time-zone';
import { useRange } from '@/lib/use-range';

export const Route = createFileRoute('/_authed/_workspace/p/$projectId/fields')({
  validateSearch: z.object({ kind: z.enum(['all', 'core', 'attribute']).optional() }),
  staticData: { crumb: 'Fields', range: true },
  loaderDeps: ({ search }) => ({ range: search.range }),
  loader: ({ context, params, deps }) => {
    context.queryClient.prefetchQuery(fieldsQuery(params.projectId, deps.range && isValidRange(deps.range) ? deps.range : DEFAULT_RANGE));
  },
  head: () => ({ meta: [{ title: 'Fields · Logbird' }] }),
  component: FieldsPage,
});

/**
 * The envelope checks behind the conformance score (docs/SPEC.md §3), with the hint shown beside each. A check whose
 * share is measured differently from the score says how in `measured` (shown on hover, and to screen readers).
 */
const MEASURED: Partial<Record<string, string>> = {
  // The score credits any target entry; the share counts targets with an id, the events `target:*` finds.
  targets: 'The score counts any target. This share counts events whose targets carry an id, the ones target:* finds.',
  occurredAt:
    'Not measured here: without a usable occurredAt, Logbird stores the time the event arrived. Setup shows how many recent payloads included occurredAt.',
  'context.operationId':
    'At least this share: the larger of the operationId and requestId shares. Events with only one of the two can make the true share higher.',
};
const CONFORMANCE_CHECKS = [
  ['occurredAt', 'When it happened, not when we received it'],
  ['actor.id', 'Who caused it'],
  ['actor.type', 'user · service · system · api_key'],
  ['outcome', 'success · failure · denied · partial'],
  ['targets', 'At least one record it touched, by id'],
  ['tenant.id', 'Which customer account'],
  ['executor.type', 'api · worker · scheduler · webhook'],
  ['context.operationId', 'or requestId — to group a request with its jobs'],
  ['description', 'A human sentence'],
] as const;

/**
 * Coverage for one conformance check, from the field keys the server reports (`tenant`, `operation`,
 * `request`, `target`…). `occurredAt` always has a value (receive time by default); checks the
 * server does not measure per field (description) return undefined and render as "—".
 */
/** Whether the operation-id share is only a lower bound: both ids are reported, and their union is not measured. */
const atLeast = (coverage: Map<string, number>) => (coverage.get('operation') ?? 0) > 0 && (coverage.get('request') ?? 0) > 0;

function checkCoverage(key: string, coverage: Map<string, number>): number | undefined {
  switch (key) {
    // Every stored event has a time: without occurredAt, Logbird stores when it arrived. How many events sent their own
    // is not measured here (Setup measures it from recent payloads), so no share is claimed (#6).
    case 'occurredAt':
      return undefined;
    case 'tenant.id':
      return coverage.get('tenant');
    // The server's `target` row: events with at least one non-empty target id, the ones `target:*` finds.
    case 'targets':
      return coverage.get('target');
    case 'context.operationId':
      // Measured (0 included) when either id is reported; unmeasured only when neither is.
      return coverage.has('operation') || coverage.has('request')
        ? Math.max(coverage.get('operation') ?? 0, coverage.get('request') ?? 0)
        : undefined;
    default:
      return coverage.get(key);
  }
}

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
    target: 'target:*',
  };
  return map[key] ?? null;
}

function FieldsPage() {
  useConsoleZone(); // Range labels and times read the console zone: re-render when the reader switches it.
  const { projectId } = Route.useParams();
  const { kind = 'all' } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { range } = useRange();
  const fields = useQuery(fieldsQuery(projectId, range));
  // Another range's coverage never shows under this range's label.
  const fieldsData = current(fields);
  const fieldsLoading = awaiting(fields);
  const [filter, setFilter] = useState('');

  const rows = useMemo(
    () =>
      (fieldsData?.data ?? []).filter((f) => (kind === 'all' || f.kind === kind) && (!filter || f.key.toLowerCase().includes(filter.toLowerCase()))),
    [fieldsData, kind, filter],
  );
  // Coverage is computed from approximate counts and can drift a hair past 100%.
  const coverage = new Map((fieldsData?.data ?? []).map((f) => [f.key, Math.min(1, f.coverage)]));
  const avg = fieldsData?.avgConformance ?? 0;

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-semibold text-xl tracking-tight">Fields</h1>
        <p className="text-muted-foreground text-sm">
          Every field Logbird has seen in {rangeInSentence(rangeLabel(range))}: recommended envelope fields and the attributes you send on top.
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
                <span className="font-semibold text-2xl tabular-nums">{fieldsLoading ? '—' : Math.round(avg)}%</span>
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
                <Link className="text-foreground underline underline-offset-2" hash="envelope" params={{ projectId }} to="/p/$projectId/setup">
                  Recommended envelope →
                </Link>
              </p>
            </div>
          </div>
        </Panel>
        <Panel title="Recommended fields">
          <ul className="flex flex-col p-2">
            {CONFORMANCE_CHECKS.map(([key, hint]) => {
              const c = checkCoverage(key, coverage);
              const good = (c ?? 0) >= 0.9;
              return (
                <li className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px]" key={key} title={MEASURED[key] ?? hint}>
                  {c === undefined ? (
                    <MinusIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : good ? (
                    <CheckIcon className="size-3.5 shrink-0 text-outcome-success" />
                  ) : (
                    <XIcon className="size-3.5 shrink-0 text-outcome-denied" />
                  )}
                  <span className="font-mono text-[12px]">{key}</span>
                  {/* On a phone the hint is hidden: keep what this share measures in view. */}
                  {key === 'targets' ? <span className="text-muted-foreground text-xs sm:hidden">by id</span> : null}
                  <span className="hidden min-w-0 flex-1 truncate text-muted-foreground text-xs sm:inline">{hint}</span>
                  {MEASURED[key] ? <span className="sr-only">{MEASURED[key]}</span> : null}
                  <span className="ms-auto shrink-0 text-muted-foreground text-xs tabular-nums">
                    {fieldsLoading
                      ? '—'
                      : key === 'occurredAt'
                        ? 'receive time if missing'
                        : c === undefined
                          ? '—'
                          : key === 'context.operationId' && atLeast(coverage)
                            ? `at least ${formatPercent(c)}`
                            : formatPercent(c)}
                  </span>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl aria-label="Field kind" size="sm">
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
            size="sm"
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
        {fieldsLoading ? (
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
                        style={{ width: `${Math.min(1, f.coverage) * 100}%` }}
                      />
                    </span>
                    <span className="w-12 text-end text-muted-foreground text-xs tabular-nums">{formatPercent(Math.min(1, f.coverage))}</span>
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
                  <Timestamp className="hidden text-muted-foreground text-xs md:block" fallback="never" format="relative" iso={f.lastSeen} />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
