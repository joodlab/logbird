import type { EntityKind, SavedView } from '@logbird/contracts';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { meQuery } from '@/lib/api/queries';
import { splitTargetId } from '@/lib/entities';
import { canonicalField, fieldTerms } from '@/lib/query-language';

export type ViewLabel = NonNullable<SavedView['state']['labels']>[number];
export type ViewLabelField = ViewLabel['field'];

const FIELD_NAMES: Record<ViewLabelField, string> = {
  actor: 'Actor',
  tenant: 'Tenant',
  executor: 'Executor',
  target: 'Record',
  impersonator: 'Support',
};

const RESOLVABLE: Partial<Record<string, ViewLabelField>> = { actor: 'actor', tenant: 'tenant', executor: 'executor', target: 'target' };
/** Bounded: one small entity lookup per term. */
const MAX_RESOLVED_TERMS = 6;

/** Explorer search params that open a saved view (and mark it open). */
export function viewSearch(view: Pick<SavedView, 'id' | 'state'>) {
  return {
    q: view.state.q || undefined,
    lang: view.state.lang === 'sql' ? ('sql' as const) : undefined,
    range: view.state.range,
    cols: view.state.columns?.join(',') || undefined,
    view: view.id,
  };
}

/** Absolute, shareable URL of a saved view. */
export function viewHref(
  projectId: string,
  view: Pick<SavedView, 'id' | 'state'>,
  origin = typeof window === 'undefined' ? '' : window.location.origin,
) {
  const params = new URLSearchParams(Object.entries(viewSearch(view)).filter((entry): entry is [string, string] => Boolean(entry[1])));
  return `${origin}/p/${projectId}/events?${params.toString()}`;
}

/** Plain field:value terms of `q` (query language only) whose value can be named: actor, tenant, executor, target. */
export function nameableTerms(q: string, lang: 'query' | 'sql' = 'query'): { field: ViewLabelField; value: string }[] {
  if (lang !== 'query' || !q.trim()) return [];
  const seen = new Set<string>();
  const out: { field: ViewLabelField; value: string }[] = [];
  for (const token of fieldTerms(q)) {
    if (token.negated || !token.value || (token.valueKind !== 'plain' && token.valueKind !== 'quoted')) continue;
    const field = RESOLVABLE[canonicalField(token.field ?? '')] ?? RESOLVABLE[token.field ?? ''];
    if (!field || seen.has(`${field}:${token.value}`)) continue;
    seen.add(`${field}:${token.value}`);
    out.push({ field, value: token.value });
  }
  return out.slice(0, MAX_RESOLVED_TERMS);
}

/** "Tenant: Bayt Al Rimal" chips for the labels whose term is still in `q`. Labels equal to their raw id are dropped. */
export function labelChips(q: string | undefined, labels: readonly ViewLabel[] | undefined, lang: 'query' | 'sql' = 'query') {
  if (!labels?.length) return [];
  const terms = new Set(nameableTerms(q ?? '', lang).map((t) => `${t.field}:${t.value}`));
  return labels
    .filter((l) => l.label.trim() && l.label !== l.value && terms.has(`${l.field}:${l.value}`))
    .map((l) => ({ ...l, text: `${FIELD_NAMES[l.field]}: ${l.label}` }));
}

/**
 * Display names for the entity terms of the query being saved (one light entity lookup per term, cached). Unknown ids
 * resolve to nothing, so the view simply keeps showing the raw query for them.
 */
export function useResolvedViewLabels(projectId: string, q: string, lang: 'query' | 'sql', enabled: boolean): ViewLabel[] {
  const terms = enabled ? nameableTerms(q, lang) : [];
  const results = useQueries({
    queries: terms.map((term) => ({
      queryKey: ['view-label', projectId, term.field, term.value] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.entities.list(projectId, { kind: term.field as EntityKind, q: term.value, limit: 10 }, signal),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  return terms.flatMap((term, i) => {
    const match = results[i]?.data?.data.find((entity) =>
      term.field === 'target' ? splitTargetId(entity.id).id === term.value : entity.id === term.value,
    );
    return match?.name && match.name !== term.value ? [{ ...term, label: match.name }] : [];
  });
}

/** Copy a view's link and say who can open it (OPS-18). */
export function useCopyViewLink() {
  const me = useQuery(meQuery());
  const workspace = me.data?.organizations.find((o) => o.id === me.data?.activeOrganizationId)?.name;
  return useCallback(
    async (projectId: string, view: Pick<SavedView, 'id' | 'state' | 'name'>) => {
      const href = viewHref(projectId, view);
      try {
        await navigator.clipboard.writeText(href);
      } catch {
        toast.error('Could not copy the link', { description: href });
        return;
      }
      toast.success('Link copied', {
        description: workspace ? `Anyone in ${workspace} can open “${view.name}”.` : `Anyone in this workspace can open “${view.name}”.`,
      });
    },
    [workspace],
  );
}
