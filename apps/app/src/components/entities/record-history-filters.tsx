import { Button } from '@logbird/ui/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import { current } from '@/lib/api/current';
import { facetQuery } from '@/lib/api/queries';
import { canonicalField, fieldTerms, hasTopLevelOr, includeTerm, removeTerm } from '@/lib/query-language';
import { ALL_RANGE } from '@/lib/range';

export function RecordHistoryFilters({
  projectId,
  baseQuery,
  query,
  onChange,
}: {
  projectId: string;
  baseQuery: string;
  query: string;
  onChange: (query: string) => void;
}) {
  const facets = useQuery(facetQuery(projectId, 'tenant', ALL_RANGE, baseQuery, 100));
  const data = current(facets);
  const tenants = data?.values.filter(({ value }) => value) ?? [];
  // Only standalone exact terms are shown as filters. A field nested in an OR is not a filter on the whole history.
  const filters = hasTopLevelOr(query)
    ? []
    : fieldTerms(query, true).filter((term) => !term.negated && !term.wildcard && (term.valueKind === 'plain' || term.valueKind === 'quoted'));
  const selectedTenant = filters.find((term) => canonicalField(term.field ?? '') === 'tenant')?.value;
  const fields = [...new Set(filters.filter((term) => canonicalField(term.field ?? '') === 'changes.field').map((term) => term.value ?? ''))];
  if (tenants.length < 2 && fields.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-2 border-b px-4 py-3 text-xs">
      {tenants.length > 1 ? (
        <>
          <p className="text-muted-foreground">This record ID appears in more than one tenant. Choose a tenant to see its history.</p>
          <fieldset aria-label="Filter history by tenant" className="flex max-h-28 min-w-0 flex-wrap items-center gap-1.5 overflow-auto p-0.5">
            {tenants.map(({ value, label }) => (
              <Button
                aria-pressed={selectedTenant === value}
                className="max-w-full"
                key={value}
                onClick={() => onChange(selectedTenant === value ? removeTerm(query, 'tenant', value, false) : includeTerm(query, 'tenant', value))}
                size="xs"
                title={value}
                variant={selectedTenant === value ? 'secondary' : 'outline'}
              >
                <bdi className="truncate">{label || value}</bdi>
              </Button>
            ))}
          </fieldset>
          {data && data.otherCount > 0 ? <p className="text-muted-foreground">Use the tenant filter to find more tenants.</p> : null}
        </>
      ) : null}
      {fields.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">Field history</span>
          {fields.map((field) => (
            <Button
              aria-label={`Remove field filter for ${field}`}
              className="max-w-full"
              key={field}
              onClick={() => onChange(removeTerm(query, 'changes.field', field, false))}
              size="xs"
              title={field}
              variant="secondary"
            >
              <bdi className="truncate font-mono">{field || '""'}</bdi>
              <XIcon />
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
