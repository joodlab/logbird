import { useQuery } from '@tanstack/react-query';
import { OutcomeDot } from '@trailmark/ui/components/badges';
import { Skeleton } from '@trailmark/ui/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@trailmark/ui/components/ui/tooltip';
import { cn } from '@trailmark/ui/lib/utils';
import { ChevronRightIcon, MinusIcon } from 'lucide-react';
import { useState } from 'react';
import { facetQuery } from '@/lib/api/queries';
import { formatCompact } from '@/lib/format';
import { placeholderKeys } from '@/lib/placeholders';
import { fieldTerms, hasTerm, queryFieldForFacet, removeTerm, toggleTerm } from '@/lib/query-language';

interface FacetSpec {
  field: string;
  label: string;
  mono?: boolean;
  defaultOpen?: boolean;
  /** Values are ids with display names as labels: show the name, keep the id secondary. */
  named?: boolean;
}

const FACETS: FacetSpec[] = [
  { field: 'outcome', label: 'Outcome', defaultOpen: true },
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
  onChange: (q: string) => void;
  className?: string;
}

/** Facet groups with counts. Click includes a value, ⌥/Alt-click (or −) excludes it. */
export function FacetSidebar({ projectId, range, q, onChange, className }: FacetSidebarProps) {
  return (
    <aside aria-label="Filters" className={cn('flex flex-col overflow-y-auto py-2', className)}>
      <div className="flex items-center justify-between px-3 pb-1">
        <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider">Filters</span>
        <span className="text-[10px] text-muted-foreground">⌥-click excludes</span>
      </div>
      {FACETS.map((f) => (
        <FacetGroup key={f.field} onChange={onChange} projectId={projectId} q={q} range={range} spec={f} />
      ))}
    </aside>
  );
}

function FacetGroup({
  spec,
  projectId,
  range,
  q,
  onChange,
}: {
  spec: FacetSpec;
  projectId: string;
  range: string;
  q: string;
  onChange: (q: string) => void;
}) {
  const queryField = queryFieldForFacet(spec.field);
  const activeTerms = fieldTerms(q).filter((t) => (t.field === 'environment' ? 'env' : t.field) === queryField);
  const [open, setOpen] = useState(Boolean(spec.defaultOpen) || activeTerms.length > 0);
  const [limit, setLimit] = useState(6);
  // Counts ignore this field's own terms so sibling values stay visible while one is selected.
  const scopedQ = removeTerm(q, queryField);
  const facet = useQuery({ ...facetQuery(projectId, spec.field, range, scopedQ, 20), enabled: open });
  const values = facet.data?.values ?? [];
  const max = Math.max(...values.map((v) => v.count), 1);

  return (
    <section className="px-1.5">
      <div className="flex items-center">
        <button
          aria-expanded={open}
          className="flex h-8 flex-1 items-center gap-1 rounded-md px-1.5 text-start font-medium text-[13px] outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => setOpen((o) => !o)}
          type="button"
        >
          <ChevronRightIcon className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-90')} />
          {spec.label}
          {activeTerms.length > 0 ? (
            <span className="ms-1 rounded-full bg-brand px-1.5 font-medium text-[10px] text-brand-foreground tabular-nums">{activeTerms.length}</span>
          ) : null}
        </button>
        {activeTerms.length > 0 ? (
          <button
            className="rounded px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => onChange(removeTerm(q, queryField))}
            type="button"
          >
            Clear
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-col gap-px pb-2 ps-2">
          {facet.isPending ? (
            placeholderKeys(3).map((k) => <Skeleton className="my-0.5 h-6 w-full" key={k} />)
          ) : values.length === 0 ? (
            <p className="px-2 py-1 text-muted-foreground text-xs">No values in this range.</p>
          ) : (
            values.slice(0, limit).map((v) => {
              const included = hasTerm(q, queryField, v.value, false);
              const excluded = hasTerm(q, queryField, v.value, true);
              return (
                <div className="group/facet relative flex items-center" key={v.value}>
                  <button
                    aria-pressed={included}
                    className={cn(
                      'relative flex h-7 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md px-2 text-start text-[12.5px] outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50',
                      included && 'bg-brand/10 text-foreground',
                      excluded && 'text-muted-foreground line-through decoration-outcome-failure/60',
                    )}
                    onClick={(e) => onChange(toggleTerm(q, queryField, v.value, e.altKey ? 'exclude' : 'include'))}
                    title={`${spec.named && v.label !== v.value ? `${v.label} (${v.value})` : v.label} — click to filter, ⌥-click to exclude`}
                    type="button"
                  >
                    <span
                      aria-hidden
                      className="absolute inset-y-1 start-0 rounded-[4px] bg-foreground/[0.045]"
                      style={{ width: `${(v.count / max) * 100}%` }}
                    />
                    {spec.field === 'outcome' ? <OutcomeDot className="relative" outcome={v.value} /> : null}
                    <span className="relative flex min-w-0 flex-1 items-baseline gap-1.5">
                      <span className={cn('min-w-0 truncate', spec.mono && 'font-mono text-[12px]', !v.label && 'text-muted-foreground italic')}>
                        {v.label || '(none)'}
                      </span>
                      {spec.named && v.label && v.label !== v.value ? (
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
                        <button
                          aria-label={`Exclude ${v.label}`}
                          className={cn(
                            'absolute end-1 flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 outline-none hover:bg-background hover:text-outcome-failure focus-visible:opacity-100 group-hover/facet:opacity-100',
                            excluded && 'text-outcome-failure opacity-100',
                          )}
                          onClick={() => onChange(toggleTerm(q, queryField, v.value, 'exclude'))}
                          type="button"
                        />
                      }
                    >
                      <MinusIcon className="size-3" />
                    </TooltipTrigger>
                    <TooltipContent side="right">{excluded ? 'Remove exclusion' : 'Exclude'}</TooltipContent>
                  </Tooltip>
                </div>
              );
            })
          )}
          {values.length > limit ? (
            <button
              className="self-start px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground"
              onClick={() => setLimit((l) => l + 10)}
              type="button"
            >
              Show more ({values.length - limit})
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
