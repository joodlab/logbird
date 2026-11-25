import type { AuditEvent } from '@logbird/contracts';
import { Button } from '@logbird/ui/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import { useMemo } from 'react';
import { current } from '@/lib/api/current';
import { facetQuery } from '@/lib/api/queries';
import { changeFieldLabel } from '@/lib/change-values';
import { applyHistoryFilter, historyFilterTerms, removeHistoryFilter } from '@/lib/history-filters';
import { ALL_RANGE } from '@/lib/range';

export function RecordHistoryFilters({
  projectId,
  baseQuery,
  live,
  query,
  rows,
  onChange,
}: {
  projectId: string;
  baseQuery: string;
  live: boolean;
  query: string;
  rows: readonly AuditEvent[];
  onChange: (query: string) => void;
}) {
  const facets = useQuery({ ...facetQuery(projectId, 'tenant', ALL_RANGE, baseQuery, 100), refetchInterval: live ? 15_000 : false });
  const data = current(facets);
  const tenants = useMemo(() => {
    // Loaded rows include arrivals the facet cache has not seen yet and provide a fallback when the facet fails.
    const byId = new Map<string, string>();
    for (const { value, label } of data?.values ?? []) if (value) byId.set(value, label || value);
    for (const { tenant } of rows) if (tenant?.id && !byId.has(tenant.id)) byId.set(tenant.id, tenant.name || tenant.id);
    const names = new Map<string, number>();
    for (const name of byId.values()) names.set(name, (names.get(name) ?? 0) + 1);
    return [...byId].map(([id, name]) => ({ id, name, showId: (names.get(name) ?? 0) > 1 }));
  }, [data, rows]);
  const selectedTenant = historyFilterTerms(query, 'tenant')[0]?.value;
  const fields = [...new Set(historyFilterTerms(query, 'changes.field').map((term) => term.value ?? ''))];
  if (tenants.length < 2 && fields.length === 0 && !facets.isError) return null;

  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-2 border-b px-4 py-3 text-xs">
      {tenants.length > 1 ? (
        <>
          <p className="text-muted-foreground">This record ID appears in more than one tenant. Choose a tenant to see its history.</p>
          <fieldset aria-label="Filter history by tenant" className="flex max-h-28 min-w-0 flex-wrap items-center gap-1.5 overflow-auto p-0.5">
            {tenants.map(({ id, name, showId }) => (
              <Button
                aria-pressed={selectedTenant === id}
                className="max-w-full"
                key={id}
                onClick={() => onChange(selectedTenant === id ? removeHistoryFilter(query, 'tenant', id) : applyHistoryFilter(query, 'tenant', id))}
                size="xs"
                title={id}
                variant={selectedTenant === id ? 'secondary' : 'outline'}
              >
                <bdi className="truncate">{name}</bdi>
                {showId ? <bdi className="min-w-0 truncate font-mono">{id}</bdi> : null}
              </Button>
            ))}
          </fieldset>
          {data && data.otherCount > 0 ? <p className="text-muted-foreground">Use the tenant filter to find more tenants.</p> : null}
        </>
      ) : null}
      {facets.isError ? (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>Couldn’t load the full list of tenants.</span>
          <Button disabled={facets.isFetching} onClick={() => facets.refetch()} size="xs" variant="outline">
            Retry
          </Button>
        </div>
      ) : null}
      {fields.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">Field history</span>
          {fields.map((field) => (
            <Button
              aria-label={`Remove field filter for ${changeFieldLabel(field)}`}
              className="max-w-full"
              key={field}
              onClick={() => onChange(removeHistoryFilter(query, 'changes.field', field))}
              size="xs"
              title={field}
              variant="secondary"
            >
              <bdi className="truncate font-mono">{changeFieldLabel(field)}</bdi>
              <XIcon />
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
