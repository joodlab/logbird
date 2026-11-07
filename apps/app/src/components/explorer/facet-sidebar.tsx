import type { QueryLang } from '@logbird/contracts';
import { OutcomeDot } from '@logbird/ui/components/badges';
import { Button } from '@logbird/ui/components/ui/button';
import { Skeleton } from '@logbird/ui/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@logbird/ui/components/ui/tooltip';
import { cn } from '@logbird/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { ChevronRightIcon, CircleAlertIcon, Loader2Icon, MinusIcon, VenetianMaskIcon } from 'lucide-react';
import { useState } from 'react';
import { facetQuery } from '@/lib/api/queries';
import { formatCompact } from '@/lib/format';
import { placeholderKeys } from '@/lib/placeholders';
import { altClickLabel, useIsMac } from '@/lib/platform';
import { hasPresenceTerm, togglePresenceTerm, withPresence } from '@/lib/presence-filter';
import { coreField } from '@/lib/query-catalog';
import { fieldTerms, hasTerm, queryFieldForFacet, removeTerm, toggleTerm } from '@/lib/query-language';
import { hasSqlPredicate, isColumnPredicate, removeSqlConjuncts, sqlConjuncts, sqlString, toggleSqlPredicate } from '@/lib/sql-language';

interface FacetSpec {
  field: string;
  label: string;
  mono?: boolean;
  defaultOpen?: boolean;
  /** Values are ids with display names as labels: show the name, keep the id secondary. */
  named?: boolean;
  /**
   * A leading "any value" row (`field:*`, ⌥/Alt-click or − for `-field:*`), and copy for when nothing has the field.
   * `*` and the values are one group (see lib/presence-filter), and counts only cover events that have the field.
   */
  presence?: { label: string; hide: string; show: string; empty: string };
}

const FACETS: FacetSpec[] = [
  { field: 'outcome', label: 'Outcome', defaultOpen: true },
  // Right after Outcome so it is above the fold at 1440×900: "was this support?" is the first question in a review.
  {
    field: 'impersonator',
    label: 'Done by support',
    defaultOpen: true,
    named: true,
    presence: {
      label: 'Any support agent',
      hide: 'Hide what support did',
      show: 'Show what support did again',
      empty: 'Nothing was done by support in this range.',
    },
  },
  { field: 'severity', label: 'Severity', defaultOpen: true },
  { field: 'action', label: 'Action', mono: true, defaultOpen: true },
  { field: 'actor', label: 'Actor', defaultOpen: true, named: true },
  { field: 'tenant', label: 'Tenant', named: true },
  { field: 'executor', label: 'Executor', named: true },
  { field: 'target', label: 'Record', named: true },
  { field: 'executor.type', label: 'Executor type', mono: true },
  { field: 'actor.type', label: 'Actor type', mono: true },
  { field: 'target.type', label: 'Target type', mono: true },
  { field: 'category', label: 'Category', mono: true },
  { field: 'source', label: 'Source', mono: true },
  { field: 'environment', label: 'Environment', mono: true },
];

interface FacetSidebarProps {
  projectId: string;
  range: string;
  q: string;
  lang?: QueryLang;
  /** Count against this query instead of `q` (the last one that ran, while `q` is rejected). */
  counts?: { q: string; lang: QueryLang };
  /** Why every count is out of date (the current query was rejected or failed). Dims all groups and says so. */
  staleReason?: string | null;
  onChange: (q: string) => void;
  className?: string;
}

/** How a facet reads and edits the query, per language. */
interface FacetOps {
  activeCount: (q: string) => number;
  /** The query without this field's own filters (so sibling values keep their counts). */
  without: (q: string) => string;
  included: (q: string, value: string) => boolean;
  excluded: (q: string, value: string) => boolean;
  toggle: (q: string, value: string, mode: 'include' | 'exclude') => string;
}

function queryOps(field: string): FacetOps {
  return {
    activeCount: (q) => fieldTerms(q).filter((t) => (t.field === 'environment' ? 'env' : t.field) === field).length,
    without: (q) => removeTerm(q, field),
    included: (q, v) => hasTerm(q, field, v, false),
    excluded: (q, v) => hasTerm(q, field, v, true),
    toggle: (q, v, mode) => toggleTerm(q, field, v, mode),
  };
}

/** SQL mode: `col = 'v'` / `col != 'v'` (arrays: `has(col, 'v')` / `NOT has(col, 'v')`), ANDed at the top level. */
function sqlOps(field: string): FacetOps {
  const info = coreField(field);
  const column = info?.column ?? field;
  const array = info?.type === 'array';
  const include = (v: string) => (array ? `has(${column}, ${sqlString(v)})` : `${column} = ${sqlString(v)}`);
  const exclude = (v: string) => (array ? `NOT has(${column}, ${sqlString(v)})` : `${column} != ${sqlString(v)}`);
  return {
    activeCount: (q) => sqlConjuncts(q).filter((c) => isColumnPredicate(c, column)).length,
    without: (q) => removeSqlConjuncts(q, (c) => isColumnPredicate(c, column)),
    included: (q, v) => hasSqlPredicate(q, include(v)),
    excluded: (q, v) => hasSqlPredicate(q, exclude(v)),
    toggle: (q, v, mode) => toggleSqlPredicate(q, mode === 'include' ? include(v) : exclude(v), column, mode),
  };
}

/** A presence facet: `*` and its values form one exclusive group in either language (no contradictory queries). */
function presenceOps(field: string, lang: QueryLang): FacetOps {
  const base = lang === 'sql' ? sqlOps(field) : queryOps(field);
  return {
    ...base,
    included: (q, v) => hasPresenceTerm(q, field, { value: v, negated: false }, lang),
    excluded: (q, v) => hasPresenceTerm(q, field, { value: v, negated: true }, lang),
    toggle: (q, v, mode) => togglePresenceTerm(q, field, v, mode, lang),
  };
}

/** Facet groups with counts. Click includes a value, ⌥/Alt-click (or −) excludes it. */
export function FacetSidebar({ projectId, range, q, lang = 'query', counts, staleReason, onChange, className }: FacetSidebarProps) {
  const isMac = useIsMac();
  return (
    <aside aria-label="Filters" className={cn('flex flex-col overflow-y-auto py-2', className)}>
      <div className="flex items-center justify-between px-3 pb-1">
        <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider">Filters</span>
        <span className="text-[10px] text-muted-foreground" data-testid="facet-exclude-hint">
          {altClickLabel(isMac)} excludes
        </span>
      </div>
      {staleReason ? (
        <p
          className="mx-3 mb-1.5 flex items-start gap-1.5 rounded-md bg-muted/70 px-2 py-1.5 text-[11px] text-muted-foreground leading-snug"
          data-testid="facets-stale"
          role="status"
        >
          <CircleAlertIcon className="mt-px size-3 shrink-0" />
          {staleReason}
        </p>
      ) : null}
      {FACETS.map((f) => (
        <FacetGroup
          counts={counts}
          isMac={isMac}
          key={f.field}
          lang={lang}
          onChange={onChange}
          projectId={projectId}
          q={q}
          range={range}
          spec={f}
          stale={Boolean(staleReason)}
        />
      ))}
    </aside>
  );
}

function FacetGroup({
  spec,
  projectId,
  range,
  q,
  lang,
  counts,
  stale,
  isMac,
  onChange,
}: {
  spec: FacetSpec;
  projectId: string;
  range: string;
  q: string;
  lang: QueryLang;
  counts?: { q: string; lang: QueryLang };
  stale: boolean;
  isMac: boolean;
  onChange: (q: string) => void;
}) {
  const queryField = queryFieldForFacet(spec.field);
  const opsFor = (l: QueryLang) => (spec.presence ? presenceOps(queryField, l) : l === 'sql' ? sqlOps(queryField) : queryOps(queryField));
  const ops = opsFor(lang);
  const activeCount = ops.activeCount(q);
  const [open, setOpen] = useState(Boolean(spec.defaultOpen) || activeCount > 0);
  const [limit, setLimit] = useState(6);
  // Counts ignore this field's own terms so sibling values stay visible while one is selected.
  const base = counts ?? { q, lang };
  const without = opsFor(base.lang).without(base.q);
  // A presence facet counts only events that have the field (`field:*`), so the empty bucket never hides in
  // otherCount: its "any value" row is then exactly the listed values plus the overflow.
  const scopedQ = spec.presence ? withPresence(without, queryField, base.lang) : without;
  const facet = useQuery({ ...facetQuery(projectId, spec.field, range, scopedQ, 20, base.lang), enabled: open });
  const allValues = facet.data?.values ?? [];
  const values = spec.presence ? allValues.filter((v) => v.value !== '') : allValues;
  const presentCount = spec.presence ? values.reduce((n, v) => n + v.count, 0) + (facet.data?.otherCount ?? 0) : 0;
  const max = Math.max(...values.map((v) => v.count), presentCount, 1);
  // Counts still belong to the previous query (keepPreviousData) until this group's own response arrives.
  const updating = facet.isPlaceholderData || (facet.isFetching && !facet.isPending);
  const failed = facet.isError && !facet.isFetching;
  const dimmed = stale || facet.isPlaceholderData || failed;

  const renderRow = (v: { value: string; label: string; count: number }, presenceRow = false) => {
    const included = ops.included(q, v.value);
    const excluded = ops.excluded(q, v.value);
    return (
      <div className="group/facet relative flex items-center" key={v.value}>
        <button
          aria-pressed={included}
          className={cn(
            'relative flex h-(--control-size-compact) min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md px-2 text-start text-[12.5px] outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50',
            included && 'bg-brand/10 text-foreground',
            excluded && 'text-muted-foreground line-through decoration-outcome-failure/60',
          )}
          onClick={(e) => onChange(ops.toggle(q, v.value, e.altKey ? 'exclude' : 'include'))}
          title={
            presenceRow
              ? `${v.label} — click for only these events, ${altClickLabel(isMac)} to hide them`
              : `${spec.named && v.label !== v.value ? `${v.label} (${v.value})` : v.label} — click to filter, ${altClickLabel(isMac)} to exclude`
          }
          type="button"
        >
          <span
            aria-hidden
            className="absolute inset-y-1 start-0 rounded-[4px] bg-foreground/[0.045]"
            style={{ width: `${(v.count / max) * 100}%` }}
          />
          {spec.field === 'outcome' ? <OutcomeDot className="relative" outcome={v.value} /> : null}
          {presenceRow ? <VenetianMaskIcon aria-hidden className="relative size-3.5 shrink-0 text-support" /> : null}
          <span className="relative flex min-w-0 flex-1 items-baseline gap-1.5">
            <span
              className={cn(
                'min-w-0 truncate',
                spec.mono && 'font-mono text-[12px]',
                presenceRow && 'font-medium',
                !v.label && 'text-muted-foreground italic',
              )}
              dir="auto"
            >
              {v.label || '(none)'}
            </span>
            {!presenceRow && spec.named && v.label && v.label !== v.value ? (
              <span className="min-w-0 shrink-[3] truncate font-mono text-[10.5px] text-muted-foreground">{v.value}</span>
            ) : null}
          </span>
          <span className="relative shrink-0 text-[11px] text-muted-foreground tabular-nums group-hover/facet:opacity-0">
            {formatCompact(v.count)}
          </span>
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={
                  presenceRow
                    ? excluded
                      ? (spec.presence?.show ?? `Show: ${spec.label}`)
                      : (spec.presence?.hide ?? `Hide: ${spec.label}`)
                    : excluded
                      ? `Stop excluding ${v.label || '(none)'}`
                      : `Exclude ${v.label || '(none)'}`
                }
                aria-pressed={excluded}
                className={cn(
                  'absolute end-1 text-muted-foreground opacity-0 hover:bg-background hover:text-outcome-failure focus-visible:opacity-100 group-hover/facet:opacity-100 dark:hover:bg-background',
                  excluded && 'text-outcome-failure opacity-100',
                )}
                onClick={() => onChange(ops.toggle(q, v.value, 'exclude'))}
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <MinusIcon className="size-3" />
          </TooltipTrigger>
          <TooltipContent side="right">
            {presenceRow ? (excluded ? spec.presence?.show : spec.presence?.hide) : excluded ? 'Remove exclusion' : 'Exclude'}
          </TooltipContent>
        </Tooltip>
      </div>
    );
  };

  return (
    <section className="px-1.5">
      <div className="flex items-center">
        <button
          aria-expanded={open}
          className="flex h-(--control-size-compact) flex-1 items-center gap-1 rounded-md px-1.5 text-start font-medium text-[13px] outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => setOpen((o) => !o)}
          type="button"
        >
          <ChevronRightIcon className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-90')} />
          {spec.label}
          {activeCount > 0 ? (
            <span className="ms-1 rounded-full bg-brand px-1.5 font-medium text-[10px] text-brand-foreground tabular-nums">{activeCount}</span>
          ) : null}
          {open && updating ? (
            <span className="ms-auto flex items-center gap-1 font-normal text-[10.5px] text-muted-foreground" data-testid="facet-updating">
              <Loader2Icon className="size-3 animate-spin" />
              updating
            </span>
          ) : open && failed ? (
            <span className="ms-auto font-normal text-[10.5px] text-destructive">counts unavailable</span>
          ) : null}
        </button>
        {activeCount > 0 ? (
          <Button className="px-2 text-muted-foreground text-xs" onClick={() => onChange(ops.without(q))} size="sm" variant="ghost">
            Clear
          </Button>
        ) : null}
      </div>
      {open ? (
        <div
          aria-busy={updating || undefined}
          className={cn('flex flex-col gap-px pb-2 ps-2 transition-opacity', dimmed && values.length > 0 && 'opacity-50')}
          data-stale={dimmed || undefined}
        >
          {facet.isPending && !facet.isError ? (
            placeholderKeys(3).map((k) => <Skeleton className="h-(--control-size-compact) w-full" key={k} />)
          ) : failed && values.length === 0 ? (
            <button
              className="self-start px-2 py-1 text-start text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => facet.refetch()}
              type="button"
            >
              Could not load these counts. Retry
            </button>
          ) : values.length === 0 ? (
            <p className="px-2 py-1 text-muted-foreground text-xs">{spec.presence?.empty ?? 'No values in this range.'}</p>
          ) : (
            <>
              {spec.presence ? renderRow({ value: '*', label: spec.presence.label, count: presentCount }, true) : null}
              {values.slice(0, limit).map((v) => renderRow(v))}
            </>
          )}
          {values.length > limit ? (
            <Button className="self-start px-2 text-muted-foreground text-xs" onClick={() => setLimit((l) => l + 10)} size="sm" variant="ghost">
              Show more ({values.length - limit})
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
