import { decodeRecordPair, type EntityKind, encodeRecordPair, formatRecordTerm, type SavedView } from '@logbird/contracts';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { meQuery } from '@/lib/api/queries';
import { splitTargetId, targetEntityId } from '@/lib/entities';
import { canonicalField, fieldTerms, hasTopLevelOr } from '@/lib/query-language';

export type ViewLabel = NonNullable<SavedView['state']['labels']>[number];
export type ViewLabelField = ViewLabel['field'];
type ViewLabelTerm = Pick<ViewLabel, 'field' | 'value'>;

const FIELD_NAMES: Record<ViewLabelField, string> = {
  actor: 'Actor',
  tenant: 'Tenant',
  executor: 'Executor',
  target: 'Record',
  record: 'Record',
  impersonator: 'Support',
};

const RESOLVABLE: Partial<Record<string, ViewLabelField>> = {
  actor: 'actor',
  tenant: 'tenant',
  executor: 'executor',
  target: 'target',
  record: 'record',
};
/** Bounded: one small entity lookup per term. */
const MAX_RESOLVED_TERMS = 6;

/** The length a record page cut its generated view names to (`entityViewName`). */
const ENTITY_VIEW_NAME_MAX = 80;

/**
 * Views saved from a record page before exact record matching (#169) hold `target:<id> target.type:<type>` (which also
 * matches the type on one target and the id on another) plus a Record label for that id. Opening one shows the exact
 * `record:<type>:<id>` form instead; nothing is written until the reader saves it. Only a record page's own save is
 * rewritten: its generated name (`<label> — <range>`), no saved columns, and a Record label for the id; the pair must
 * lead the query, be plain and positive, and be ANDed with the rest (no top-level OR). A query typed in the explorer and
 * saved there (its own name and columns, even with a resolved Record label) is left exactly as written.
 */
export function upgradeRecordView(view: Pick<SavedView, 'name' | 'state'>): { state: SavedView['state']; upgraded: boolean } {
  const { state } = view;
  const q = state.q ?? '';
  const label = state.labels?.find((l) => l.field === 'target');
  if (state.lang === 'sql' || !label || hasTopLevelOr(q)) return { state, upgraded: false };
  // The record page named it `<label> — <range>`, cut to 80 characters: a long label can leave only a prefix of it.
  const generated = `${label.label} — `;
  const pageName = view.name.startsWith(generated) || (view.name.length === ENTITY_VIEW_NAME_MAX && generated.startsWith(view.name));
  if (state.columns !== undefined || !pageName) return { state, upgraded: false };
  const [first, second] = fieldTerms(q);
  const simple = (t: typeof first) => t && !t.negated && !t.wildcard && (t.valueKind === 'plain' || t.valueKind === 'quoted') && t.value;
  if (!simple(first) || !simple(second) || !first || !second) return { state, upgraded: false };
  if (canonicalField(first.field ?? '') !== 'target' || canonicalField(second.field ?? '') !== 'target.type') return { state, upgraded: false };
  if (q.slice(0, first.start).trim() || q.slice(first.end, second.start).trim() || first.value !== label.value) return { state, upgraded: false };
  const type = second.value ?? '';
  const id = first.value ?? '';
  const rest = q.slice(second.end).trim();
  const record = encodeRecordPair(type, id);
  return {
    upgraded: true,
    state: {
      ...state,
      q: rest ? `${formatRecordTerm(type, id)} ${rest}` : formatRecordTerm(type, id),
      labels: state.labels?.map((l) => (l === label ? { ...l, field: 'record' as const, value: record } : l)),
    },
  };
}

/** Explorer search params that open a saved view (and mark it open). */
export function viewSearch(view: Pick<SavedView, 'id' | 'state'> & { name?: string }) {
  // An old record-page view opens in its exact form; the explorer banner says so and offers to save it. (Links built
  // without the name open as saved; the explorer route upgrades those on arrival.)
  const { state } = view.name === undefined ? { state: view.state } : upgradeRecordView({ name: view.name, state: view.state });
  return {
    q: state.q || undefined,
    lang: state.lang === 'sql' ? ('sql' as const) : undefined,
    range: state.range,
    cols: state.columns?.join(',') || undefined,
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
export function nameableTerms(q: string, lang: 'query' | 'sql' = 'query'): ViewLabelTerm[] {
  if (lang !== 'query' || !q.trim()) return [];
  const seen = new Set<string>();
  const out: ViewLabelTerm[] = [];
  for (const token of fieldTerms(q)) {
    if (token.negated || token.wildcard || !token.value || (token.valueKind !== 'plain' && token.valueKind !== 'quoted')) continue;
    const field = RESOLVABLE[canonicalField(token.field ?? '')] ?? RESOLVABLE[token.field ?? ''];
    if (!field) continue;
    const pair = field === 'record' ? decodeRecordPair(token.value) : undefined;
    if (pair === null) continue;
    const value = pair ? encodeRecordPair(pair.type, pair.id) : token.value;
    const key = `${field}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ field, value });
  }
  return out.slice(0, MAX_RESOLVED_TERMS);
}

export async function resolveViewLabel(projectId: string, term: ViewLabelTerm, signal?: AbortSignal): Promise<ViewLabel | undefined> {
  let name: string | undefined;
  let id = term.value;
  if (term.field === 'record') {
    const pair = decodeRecordPair(term.value);
    if (!pair) return undefined;
    id = pair.id;
    const metadata = await api.entities.metadata(projectId, 'target', targetEntityId(pair.type, pair.id), pair.type, signal);
    name = metadata.name;
  } else {
    const { data } = await api.entities.list(projectId, { kind: term.field as EntityKind, q: id, limit: 10 }, signal);
    name = data.find((entity) => (term.field === 'target' ? splitTargetId(entity.id, entity.type).id : entity.id) === id)?.name;
  }
  return name && name !== id ? { ...term, label: name.slice(0, 200) } : undefined;
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
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await resolveViewLabel(projectId, term, signal)) ?? null,
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  return results.flatMap(({ data }) => (data ? [data] : []));
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
