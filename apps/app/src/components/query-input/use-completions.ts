import { useDebouncedValue } from '@tanstack/react-pacer';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { QueryLang, SavedView, SuggestResponse } from '@trailmark/contracts';
import { useMemo } from 'react';
import { fieldsQuery, SUGGEST_LIMIT, suggestQuery } from '@/lib/api/queries';
import { formatCompact } from '@/lib/format';
import {
  attributeKey,
  attributeQueryKey,
  coreField,
  QUERY_KEYS,
  type QueryKeySpec,
  SQL_COLUMNS,
  SQL_FUNCTIONS,
  SQL_KEYWORDS,
  sqlColumn,
  sqlSignature,
  TYPE_BADGE,
} from '@/lib/query-catalog';
import { formatTerm, type QueryCompletion, queryCompletionAt, quoteIfNeeded } from '@/lib/query-language';
import { lintQuery, type QueryFix } from '@/lib/query-lint';
import type { RecentQuery } from '@/lib/recent-queries';
import { type SqlCompletion, sqlCallAt, sqlCompletionAt } from '@/lib/sql-language';
import { type Hint, queryHint, sqlHint } from './hints';

export type SuggestionKind = 'key' | 'term' | 'value' | 'snippet' | 'column' | 'function' | 'keyword' | 'attr' | 'recent' | 'view' | 'fix';

export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  /** Section header the row is listed under ("Fields", "Values for tenant", "Recent"…). */
  group: string;
  label: string;
  /** Small type badge (str, num, attr, fn…). */
  badge?: string;
  detail?: string;
  /** Right-aligned count / coverage / age. */
  meta?: string;
  /** Show the label in the UI font (display names), with the inserted value as a mono detail. */
  named?: boolean;
  /** Replace draft[from, to) with `insert`, then put the caret at `caret`. */
  from: number;
  to: number;
  insert: string;
  caret: number;
  /** Keep the menu open after accepting (e.g. `key:` → value suggestions). */
  keepOpen?: boolean;
  /** Run the query right after accepting (a recent query is complete). */
  run?: boolean;
  /** The recent query this row shows (removable from the panel). */
  recent?: RecentQuery;
  /** Open this saved view instead of inserting text. */
  view?: SavedView;
}

export interface Completions {
  suggestions: Suggestion[];
  /** What the token under the caret expects (the syntax hint row). */
  hint: Hint | null;
  /** What the user typed for the current completion (Enter accepts only partial matches). */
  prefix: string;
  loading: boolean;
  context: QueryCompletion | SqlCompletion;
  /** Lucene / KQL spellings found in the draft (query language only). */
  fixes: QueryFix[];
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

/** `tnm` → tenant.name: every character of `p` in order, the first one at a word start. */
function subsequence(p: string, l: string): boolean {
  if (p.length < 2) return false;
  let i = 0;
  for (let j = 0; j < l.length && i < p.length; j += 1) {
    if (l[j] === p[i] && (i > 0 || j === 0 || /[._\s-]/.test(l[j - 1] ?? ''))) i += 1;
  }
  return i === p.length;
}

/**
 * 0 = prefix, 1 = word-segment prefix (`name` → actor.name / actor_name), 2 = substring, 3 = fuzzy subsequence
 * (`tnm` → tenant.name), 4 = in description, -1 = no match.
 */
export function matchScore(prefix: string, label: string, extra = ''): number {
  if (!prefix) return 0;
  const p = prefix.toLowerCase();
  const l = label.toLowerCase();
  if (l.startsWith(p)) return 0;
  if (l.split(/[._\s'[\]-]/).some((seg) => seg.startsWith(p))) return 1;
  if (l.includes(p)) return 2;
  if (subsequence(p, l)) return 3;
  if (extra && p.length >= 3 && extra.toLowerCase().includes(p)) return 4;
  return -1;
}

function ranked<T>(items: T[], score: (item: T) => number, limit = 60): T[] {
  return items
    .map((item, index) => ({ item, index, s: score(item) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.item);
}

/** Keep groups contiguous (in order of first appearance) so each header is rendered once. */
export function groupStable(items: Suggestion[]): Suggestion[] {
  const order: string[] = [];
  const by = new Map<string, Suggestion[]>();
  for (const s of items) {
    if (!by.has(s.group)) {
      by.set(s.group, []);
      order.push(s.group);
    }
    by.get(s.group)?.push(s);
  }
  return order.flatMap((g) => by.get(g) ?? []);
}

function bestScore(scores: number[]): number {
  const ok = scores.filter((s) => s >= 0);
  return ok.length ? Math.min(...ok) : -1;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => isoDay(new Date(Date.now() - n * 86_400_000));
const escapeSql = (v: string) => v.replace(/[\\']/g, '\\$&');
const coverageLabel = (c: number) => (c >= 0.995 ? '100%' : c >= 0.01 ? `${Math.round(c * 100)}%` : c > 0 ? '<1%' : undefined);

export function ageLabel(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Where values for a completion come from: a /suggest field, or nothing. */
function suggestField(context: QueryCompletion | SqlCompletion): string | null {
  if (context.kind !== 'value') return null;
  if (/^(attr|attributes)\./.test(context.field)) return context.field;
  const core = coreField(context.field);
  if (core) return core.suggest === 'none' ? null : core.key;
  return context.field; // bare attribute key (metadata.channel)
}

/** Fields whose values are searched when free text is typed (ids with display names, and actions). */
const ENTITY_FIELDS = ['tenant', 'actor', 'action'] as const;

interface Attribute {
  key: string;
  coverage: number;
  samples: string[];
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

export function useCompletions({
  projectId,
  range,
  lang,
  draft,
  caret,
  open,
  recent = [],
  views = [],
}: {
  projectId: string;
  range: string;
  lang: QueryLang;
  draft: string;
  caret: number;
  open: boolean;
  recent?: RecentQuery[];
  views?: SavedView[];
}): Completions {
  const context = useMemo<QueryCompletion | SqlCompletion>(
    () => (lang === 'sql' ? sqlCompletionAt(draft, caret, (column) => sqlColumn(column)?.suggestField) : queryCompletionAt(draft, caret)),
    [lang, draft, caret],
  );

  // Field metadata (types, coverage, attribute keys) is cheap and cached; it also tells the linter which bare
  // words are fields.
  const fields = useQuery({ ...fieldsQuery(projectId, range), enabled: open, staleTime: 5 * 60_000 });
  const { attributes, coverage } = useMemo(() => {
    const attrs: Attribute[] = [];
    const cov = new Map<string, number>();
    for (const f of fields.data?.data ?? []) {
      if (f.kind === 'attribute') attrs.push({ key: attributeKey(f.key), coverage: f.coverage, samples: f.samples });
      else {
        const core = coreField(f.key);
        if (core) cov.set(core.key, Math.max(cov.get(core.key) ?? 0, f.coverage));
      }
    }
    attrs.sort((a, b) => b.coverage - a.coverage);
    return { attributes: attrs, coverage: cov };
  }, [fields.data]);

  const fixes = useMemo(() => {
    if (lang !== 'query' || !draft) return [];
    const known = new Set(attributes.map((a) => a.key));
    return lintQuery(draft, (name) => Boolean(coreField(name)) || /^(attr|attributes)\.\S/.test(name) || known.has(name));
  }, [lang, draft, attributes]);

  /* ---------------- values: cached per field + prefix, debounced, no flicker ---------------- */
  const valueField = open ? suggestField(context) : null;
  const rawPrefix = context.kind === 'value' ? context.prefix : '';
  const [debouncedPrefix] = useDebouncedValue(rawPrefix, { wait: 150 });
  const base = useQuery({ ...suggestQuery(projectId, valueField ?? '', ''), enabled: Boolean(valueField) });
  // Fewer values than the limit means the unfiltered list is complete: filter it locally, no request per key.
  const complete = base.data?.field === valueField && (base.data?.values.length ?? SUGGEST_LIMIT) < SUGGEST_LIMIT;
  const narrowed = useQuery({
    ...suggestQuery(projectId, valueField ?? '', debouncedPrefix),
    enabled: Boolean(valueField) && Boolean(debouncedPrefix) && !complete,
    // Keep the previous list while the next prefix loads, but never across fields.
    placeholderData: (previous: SuggestResponse | undefined) => (previous?.field === valueField ? previous : undefined),
  });
  const valuesData = rawPrefix && !complete ? (narrowed.data ?? base.data) : base.data;
  const valuesLoading = Boolean(valueField) && (base.isFetching || (Boolean(rawPrefix) && !complete && narrowed.isFetching));

  /* ---------------- free text that names an entity (`rawd` → tenant:biz_2 Rawda Suites) ---------------- */
  const word =
    open && lang === 'query' && context.kind === 'key' && /^[^:.*"()]{3,}$/.test(context.prefix) && !/^[A-Z]+$/.test(context.prefix)
      ? context.prefix
      : '';
  const [debouncedWord] = useDebouncedValue(word, { wait: 200 });
  const entityQueries = useQueries({
    queries: ENTITY_FIELDS.map((field) => ({
      ...suggestQuery(projectId, field, debouncedWord),
      enabled: Boolean(debouncedWord) && word.toLowerCase().includes(debouncedWord.toLowerCase()),
      // The previous word's matches, filtered locally by the current word, hold the rows while the next loads.
      placeholderData: (previous: SuggestResponse | undefined) => (previous?.field === field ? previous : undefined),
    })),
  });
  const entityData = entityQueries.map((q) => q.data);
  // biome-ignore lint/correctness/useExhaustiveDependencies: entityData is a fresh array each render; its items are stable query results
  const entities = useMemo(() => {
    const w = word.toLowerCase();
    if (!w) return [];
    return entityData.flatMap((d) =>
      (d?.values ?? [])
        .filter((v) => v.value.toLowerCase().includes(w) || v.label.toLowerCase().includes(w))
        .slice(0, 3)
        .map((v) => ({ field: d?.field ?? '', ...v })),
    );
  }, [word, ...entityData]);

  return useMemo<Completions>(() => {
    const empty: Completions = { suggestions: [], hint: null, prefix: '', loading: false, context, fixes };
    if (!open) return empty;
    const values = valuesData?.field === valueField ? (valuesData?.values ?? []) : [];
    const call = lang === 'sql' ? sqlCallAt(draft, caret) : null;
    const input = {
      draft,
      caret,
      lang,
      context,
      fixes,
      attributes,
      coverage,
      values,
      valueField,
      valuesLoading,
      recent: recent.filter((r) => r.lang === lang),
      views,
      call,
      entities,
    };
    const suggestions = groupStable(lang === 'sql' ? sqlSuggestions(input) : querySuggestions(input));
    const hint = lang === 'sql' ? sqlHint(context as SqlCompletion, draft, call) : queryHint(context as QueryCompletion, draft, caret, fixes);
    return {
      suggestions,
      hint,
      prefix: 'prefix' in context ? context.prefix : '',
      loading: valuesLoading || (fields.isFetching && !fields.data),
      context,
      fixes,
    };
  }, [
    open,
    context,
    draft,
    caret,
    lang,
    fixes,
    attributes,
    coverage,
    valuesData,
    valueField,
    valuesLoading,
    recent,
    views,
    entities,
    fields.isFetching,
    fields.data,
  ]);
}

interface Input {
  draft: string;
  caret: number;
  lang: QueryLang;
  context: QueryCompletion | SqlCompletion;
  fixes: QueryFix[];
  attributes: Attribute[];
  coverage: Map<string, number>;
  values: SuggestResponse['values'];
  valueField: string | null;
  valuesLoading: boolean;
  recent: RecentQuery[];
  views: SavedView[];
  /** SQL: the function call around the caret (no trailing space after an argument). */
  call: { name: string; arg: number } | null;
  /** Entity values whose id or name contains the free-text word being typed. */
  entities: (SuggestResponse['values'][number] & { field: string })[];
}

/* ------------------------------------------------------------------ */
/* Shared groups                                                       */
/* ------------------------------------------------------------------ */

function recentItems({ draft, recent }: Input, limit: number, filter?: string): Suggestion[] {
  const f = filter?.toLowerCase();
  return recent
    .filter((r) => !f || (r.q.toLowerCase().includes(f) && r.q !== draft))
    .slice(0, limit)
    .map((r) => ({
      id: `recent:${r.lang}:${r.q}`,
      kind: 'recent' as const,
      group: 'Recent',
      label: r.q,
      meta: ageLabel(r.at),
      from: 0,
      to: draft.length,
      insert: r.q,
      caret: r.q.length,
      run: true,
      recent: r,
    }));
}

function viewItems({ draft, views }: Input, limit: number): Suggestion[] {
  return views.slice(0, limit).map((v) => ({
    id: `view:${v.id}`,
    kind: 'view' as const,
    group: 'Saved views',
    label: v.name,
    badge: v.state.lang === 'sql' ? 'SQL' : undefined,
    detail: v.state.q || 'All events',
    from: 0,
    to: draft.length,
    insert: v.state.q ?? '',
    caret: (v.state.q ?? '').length,
    view: v,
  }));
}

function fixItems({ fixes, caret, draft }: Input): Suggestion[] {
  // The fix under (or right before) the caret first; one is enough to make the point.
  const near = fixes.find((f) => caret >= f.start && caret <= f.end) ?? (draft.trim() ? undefined : fixes[0]);
  if (!near) return [];
  const space = near.incomplete || /^\s/.test(draft.slice(near.end)) || near.end < draft.length ? '' : ' ';
  return [
    {
      id: `fix:${near.start}:${near.replacement}`,
      kind: 'fix',
      group: 'Did you mean',
      label: near.replacement,
      detail: near.message,
      from: near.start,
      to: near.end,
      insert: near.replacement + space,
      caret: near.start + near.replacement.length + space.length,
      keepOpen: near.incomplete,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Query language                                                      */
/* ------------------------------------------------------------------ */

const OPERATOR_ROWS: { op: string; detail: string; insert?: string; back?: number }[] = [
  { op: 'OR', detail: 'Either side matches · AND binds tighter' },
  { op: 'AND', detail: 'Both match · same as a space' },
  { op: 'NOT', detail: 'Exclude the next term' },
  { op: '-', detail: 'Exclude: -field:value', insert: '-' },
  { op: '( )', detail: 'Group terms: (a OR b) c', insert: '()', back: 1 },
];

function keyItem(
  key: string,
  spec: Pick<Suggestion, 'id' | 'kind' | 'badge' | 'detail' | 'meta' | 'group'>,
  c: { from: number; to: number },
): Suggestion {
  // Re-keying an existing term (`act|or:usr_1`) replaces through its colon, so the value is kept.
  const insert = `${key}:`;
  return { ...spec, label: key, from: c.from, to: c.to, insert, caret: c.from + insert.length, keepOpen: true };
}

function fieldItems(input: Input, p: string, c: { from: number; to: number }, typedAttr?: string): Suggestion[] {
  const { attributes, coverage } = input;
  const covered = (f: QueryKeySpec) => coverage.get(f.key) ?? 0;
  // With no prefix: core fields the project actually uses first (console order), then unused ones.
  const core = typedAttr
    ? []
    : p
      ? ranked(QUERY_KEYS, (f) => bestScore([f.key, ...(f.aliases ?? [])].map((k) => matchScore(p, k, f.description))))
      : [...QUERY_KEYS].sort((a, b) => Number(covered(b) > 0) - Number(covered(a) > 0));
  const coreItems = core.map((f) =>
    keyItem(
      f.key,
      { id: `k:${f.key}`, kind: 'key', group: 'Fields', badge: TYPE_BADGE[f.type], detail: f.description, meta: coverageLabel(covered(f)) },
      c,
    ),
  );
  const attrs = ranked(attributes, (a) => matchScore(p, a.key, a.samples.join(' ')), p ? 40 : 25).map((a) =>
    keyItem(
      typedAttr ? `${typedAttr}${a.key}` : attributeQueryKey(a.key),
      {
        id: `a:${a.key}`,
        kind: 'attr',
        group: 'Attributes',
        badge: TYPE_BADGE.attr,
        detail: a.samples.length ? a.samples.slice(0, 3).join(' · ') : undefined,
        meta: coverageLabel(a.coverage),
      },
      c,
    ),
  );
  return [...coreItems, ...attrs];
}

function querySuggestions(input: Input): Suggestion[] {
  const { draft } = input;
  const context = input.context as QueryCompletion;
  const after = (to: number) => draft.slice(to);
  const fix = fixItems(input);

  if (context.kind === 'key') {
    const raw = context.prefix;
    const typedAttr = /^(attr|attributes)\./.exec(raw)?.[0];
    const p = typedAttr ? raw.slice(typedAttr.length) : raw;
    const blank = draft.trim() === '';

    if (blank) {
      // Focus on an empty bar: pick up where you left off, open a view, or start from a field.
      return [...recentItems(input, 6), ...viewItems(input, 4), ...fieldItems(input, '', context)];
    }

    const fields = fieldItems(input, p, context, typedAttr);
    const replacesColon = draft[context.to - 1] === ':';
    const shortcuts: Suggestion[] =
      replacesColon || typedAttr
        ? []
        : ranked(
            QUERY_KEYS.filter((f) => f.presenceShortcut),
            (f) => (p ? matchScore(p, `${f.key}:*`, f.presence) : 0),
          ).map((f) => {
            const term = `${f.key}:*`;
            const space = /^\s/.test(after(context.to)) ? '' : ' ';
            return {
              id: `t:${term}`,
              kind: 'term' as const,
              group: 'Fields',
              label: term,
              detail: f.presence,
              from: context.from,
              to: context.to,
              insert: term + space,
              caret: context.from + term.length + space.length,
            };
          });

    // Boolean operators: after a complete term (OR, AND, NOT, group), else NOT / group only.
    const upper = p === p.toUpperCase() && /^[A-Z]+$/.test(p);
    const operators = OPERATOR_ROWS.filter((o) => (context.afterTerm || o.op === 'NOT' || o.op === '-' || o.op === '( )') && !replacesColon)
      .filter((o) => (p ? /^[A-Z]+$/.test(o.op) && o.op.startsWith(p.toUpperCase()) && o.op !== p : true))
      .map((o): Suggestion => {
        const text = o.insert ?? o.op;
        const space = o.insert || /^\s/.test(after(context.to)) ? '' : ' ';
        return {
          id: `op:${o.op}`,
          kind: 'keyword',
          group: 'Combine',
          label: o.op,
          badge: TYPE_BADGE.kw,
          detail: o.detail,
          from: context.from,
          to: context.to,
          insert: text + space,
          caret: context.from + text.length + space.length - (o.back ?? 0),
          keepOpen: true,
        };
      });
    const fieldsAndShortcuts = [...fields.filter((f) => f.group === 'Fields'), ...shortcuts, ...fields.filter((f) => f.group !== 'Fields')];
    const atEnd = input.caret === draft.length;
    const recents = atEnd && draft.trim().length >= 2 ? recentItems(input, 3, draft.trim()) : [];
    const space = /^\s/.test(after(context.to)) ? '' : ' ';
    const matches: Suggestion[] = input.entities.map((e) => {
      const term = formatTerm(e.field, e.value);
      const named = e.label !== e.value;
      return {
        id: `m:${e.field}:${e.value}`,
        kind: 'term' as const,
        group: 'Matching values',
        label: named ? e.label : term,
        named,
        badge: e.field,
        detail: named ? term : undefined,
        meta: formatCompact(e.count),
        from: context.from,
        to: context.to,
        insert: term + space,
        caret: context.from + term.length + space.length,
      };
    });
    // An upper-case prefix after a term is an operator being typed (`O` → OR).
    // Right after a complete term (nothing typed yet) or with an upper-case prefix (`O` → OR), boolean operators
    // lead, as in Kibana; any lower-case letter goes straight to fields.
    return context.afterTerm && (upper || !p)
      ? [...fix, ...operators, ...fieldsAndShortcuts, ...matches, ...recents]
      : [...fix, ...fieldsAndShortcuts, ...matches, ...recents, ...operators];
  }

  if (context.kind === 'exists') {
    const p = context.prefix;
    const keys = ranked(QUERY_KEYS, (f) => matchScore(p, f.key, f.description)).map((f) => f.key);
    const attrs = ranked(input.attributes, (a) => matchScore(p, a.key), 20).map((a) => attributeQueryKey(a.key));
    const space = /^\s/.test(after(context.to)) ? '' : ' ';
    return [...keys, ...attrs].map((key) => {
      const term = `${key}:*`;
      return {
        id: `ex:${key}`,
        kind: 'term' as const,
        group: 'Field exists',
        label: term,
        detail: `_exists_:${key}`,
        from: context.from,
        to: context.to,
        insert: term + space,
        caret: context.from + term.length + space.length,
      };
    });
  }

  if (context.kind === 'value') return [...fix, ...queryValueItems(input, context)];
  return fix;
}

function queryValueItems(input: Input, context: Extract<QueryCompletion, { kind: 'value' }>): Suggestion[] {
  const { draft, values, valueField, valuesLoading } = input;
  const after = draft.slice(context.to);
  const p = context.prefix;
  const pl = p.toLowerCase();
  const core = coreField(context.field);
  const type = core?.type ?? 'attr';
  const bare = !context.op && !context.quoted && !context.inGroup && p === '';
  const trailing = (keepOpen?: boolean) => (keepOpen || context.inGroup || /^[\s)]/.test(after) ? '' : ' ');
  const valuesGroup = `Values for ${context.field}`;
  const items: Suggestion[] = [];

  const snippet = (id: string, label: string, detail: string, insert: string, back = 0, keepOpen = false, group = 'Operators'): Suggestion => {
    const space = trailing(keepOpen || back > 0);
    return {
      id: `snip:${id}`,
      kind: 'snippet',
      group,
      label,
      detail,
      from: context.from,
      to: context.to,
      insert: insert + space,
      caret: context.from + insert.length + space.length - back,
      keepOpen: keepOpen || back > 0,
    };
  };

  // Inside `field:( … )` after a member: OR comes next.
  if (context.inGroup && context.afterMember && (!p || ('OR'.startsWith(p) && p === p.toUpperCase()))) {
    items.push({
      id: 'grp:OR',
      kind: 'keyword',
      group: 'Combine',
      label: 'OR',
      badge: TYPE_BADGE.kw,
      detail: 'Any of these values',
      from: context.from,
      to: context.to,
      insert: 'OR ',
      caret: context.from + 3,
      keepOpen: true,
    });
  }

  /* Comparisons and quick dates first for numbers and dates (no value list to show). */
  if (type === 'date') {
    const since = (n: number, label: string) => snippet(`since:${n}`, `>${daysAgo(n)}`, label, `>${daysAgo(n)}`, 0, false, 'Quick ranges');
    if (bare) {
      items.push(since(1, 'Last 24 hours'), since(7, 'Last 7 days'), since(30, 'Last 30 days'));
      items.push(
        snippet(
          'between',
          `[${daysAgo(7)} TO ${isoDay(new Date())}]`,
          'Between two dates, inclusive',
          `[${daysAgo(7)} TO ${isoDay(new Date())}]`,
          0,
          false,
          'Quick ranges',
        ),
      );
      items.push(
        snippet('after', '>', 'After a date (YYYY-MM-DD or ISO-8601, UTC)', '>', 0, true),
        snippet('before', '<', 'Before a date', '<', 0, true),
      );
    } else if (context.op && !p) {
      for (const [n, label] of [
        [0, 'Today (UTC midnight)'],
        [1, 'Yesterday'],
        [7, '7 days ago'],
        [30, '30 days ago'],
      ] as const) {
        items.push(snippet(`d:${n}`, daysAgo(n), label, daysAgo(n), 0, false, 'Dates'));
      }
    }
    return items;
  }
  if (type === 'number') {
    if (bare) {
      items.push(
        snippet('gt', '>', 'Greater than', '>', 0, true),
        snippet('gte', '>=', 'Greater than or equal', '>=', 0, true),
        snippet('lt', '<', 'Less than', '<', 0, true),
        snippet('lte', '<=', 'Less than or equal', '<=', 0, true),
        snippet('range', '[a TO b]', 'Range, inclusive — { } excludes, * is open', '[ TO ]', 5),
      );
    }
    return items;
  }

  /* Values (strings, arrays, attributes), ranked by count by /suggest. */
  if (!context.op) {
    const matching = values.filter((v) => !pl || v.value.toLowerCase().includes(pl) || v.label.toLowerCase().includes(pl));
    // /suggest counts for attributes are the key's frequency, not the value's: don't show them per value.
    const attributeValues = valueField !== null && !coreField(valueField);
    for (const v of matching) {
      const insert = quoteIfNeeded(v.value) + trailing();
      const named = Boolean(v.label && v.label !== v.value);
      items.push({
        id: `v:${v.value}`,
        kind: 'value',
        group: valuesGroup,
        label: named ? v.label : v.value,
        detail: named ? v.value : undefined,
        named,
        meta: attributeValues ? undefined : formatCompact(v.count),
        from: context.from,
        to: context.to,
        insert,
        caret: context.from + insert.length,
      });
    }
    if (!matching.length && valuesLoading) {
      // Hold the panel's shape while the first values for this field load.
      items.push({
        id: 'loading',
        kind: 'snippet',
        group: valuesGroup,
        label: 'Loading values…',
        from: context.from,
        to: context.from,
        insert: '',
        caret: context.from,
      });
    }
  }

  /* Operators for string-like fields, after the values. */
  if (bare) {
    if (type !== 'text') items.push(snippet('presence', '*', core?.presence ?? `Has ${context.field} (non-empty)`, '*'));
    items.push(snippet('phrase', '"…"', 'Exact value with spaces or symbols', '""', 1));
    if (type !== 'text') {
      items.push(snippet('group', '(a OR b)', 'Any of these values', '()', 1));
      items.push(snippet('regex', '/regex/', 'RE2 regex on the whole value', '//', 1));
    }
    if (type === 'attr') {
      items.push(snippet('gt', '>', 'Compare as a number or date', '>', 0, true), snippet('range', '[a TO b]', 'Numeric or date range', '[ TO ]', 5));
    }
  } else if (p && !context.quoted && !p.endsWith('*') && type !== 'text' && !context.op) {
    const term = `${quoteIfNeeded(p) === p ? p : ''}*`;
    if (term !== '*') items.push(snippet('prefix', term, `Starts with “${p}”`, term));
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* SQL mode                                                            */
/* ------------------------------------------------------------------ */

const SQL_COMPARE: { op: string; detail: string; insert: string; back?: number }[] = [
  { op: '=', detail: 'Equals', insert: '= ' },
  { op: '!=', detail: 'Not equal', insert: '!= ' },
  { op: 'IN (…)', detail: 'Any of these values', insert: 'IN ()', back: 1 },
  { op: 'NOT IN (…)', detail: 'None of these values', insert: 'NOT IN ()', back: 1 },
  { op: '>', detail: 'Greater than', insert: '> ' },
  { op: '>=', detail: 'Greater than or equal', insert: '>= ' },
  { op: '<', detail: 'Less than', insert: '< ' },
  { op: 'LIKE', detail: "Pattern: '%text%' (ILIKE ignores case)", insert: "LIKE '%%'", back: 2 },
  { op: 'BETWEEN … AND …', detail: 'Inclusive range', insert: 'BETWEEN ' },
];

function sqlSuggestions(input: Input): Suggestion[] {
  const { attributes, draft, values, valuesLoading } = input;
  const context = input.context as SqlCompletion;
  if (context.kind === 'ident' && draft.trim() === '') {
    return [...recentItems(input, 6), ...viewItems(input, 4), ...sqlIdentItems(input, { ...context, prefix: '' })];
  }
  if (context.kind === 'ident') {
    const p = context.prefix;
    if (context.after === 'column') {
      const column = context.column ?? '';
      const type = sqlColumn(column)?.type ?? (column.startsWith('attributes[') ? 'string' : undefined);
      const ops = type === 'array' ? [] : SQL_COMPARE.filter((o) => !p || o.op.toUpperCase().startsWith(p.toUpperCase()));
      return ops.map((o) => ({
        id: `cmp:${o.op}`,
        kind: 'keyword' as const,
        group: `Compare ${column}`,
        label: o.op,
        detail: o.detail,
        from: context.from,
        to: context.to,
        insert: o.insert,
        caret: context.from + o.insert.length - (o.back ?? 0),
        keepOpen: true,
      }));
    }
    if (context.after === 'operand') {
      return ['AND', 'OR', 'AND NOT']
        .filter((k) => !p || (k.startsWith(p.toUpperCase()) && k !== p.toUpperCase()))
        .map((k) => ({
          id: `kw:${k}`,
          kind: 'keyword' as const,
          group: 'Combine',
          label: k,
          badge: TYPE_BADGE.kw,
          detail: k === 'OR' ? 'Wrap ORs in ( ) when mixing with AND' : undefined,
          from: context.from,
          to: context.to,
          insert: `${k} `,
          caret: context.from + k.length + 1,
          keepOpen: true,
        }));
    }
    return sqlIdentItems(input, context);
  }

  if (context.kind === 'attrKey') {
    return ranked(attributes, (a) => matchScore(context.prefix, a.key, a.samples.join(' '))).map((a): Suggestion => {
      // An open string gets its closers; a closed one keeps them and the caret jumps past `']`.
      const insert = `${escapeSql(a.key)}${context.closeQuote ? `'${context.closeBracket ? ']' : ''}` : ''}`;
      const skip = context.closeQuote ? 0 : 1 + (context.closeBracket ? 0 : 1);
      return {
        id: `ak:${a.key}`,
        kind: 'attr',
        group: 'Attribute keys',
        label: a.key,
        badge: TYPE_BADGE.attr,
        detail: a.samples.slice(0, 3).join(' · ') || undefined,
        meta: coverageLabel(a.coverage),
        from: context.from,
        to: context.to,
        insert,
        caret: context.from + insert.length + skip,
        keepOpen: false,
      };
    });
  }

  if (context.kind === 'value') {
    const pl = context.prefix.toLowerCase();
    const attributeValues = context.field.startsWith('attr.');
    const items: Suggestion[] = values
      .filter((v) => !pl || v.value.toLowerCase().includes(pl) || v.label.toLowerCase().includes(pl))
      .map((v) => {
        const body = escapeSql(v.value);
        // `actor_name =|` gets a space before the literal; `IN (|` and `has(col, |` do not need one.
        const lead = context.openQuote && !/[\s(]/.test(draft[context.from - 1] ?? ' ') ? ' ' : '';
        const insert = context.openQuote ? `${lead}'${body}'` : `${body}${context.closeQuote ? "'" : ''}`;
        const named = Boolean(v.label && v.label !== v.value);
        return {
          id: `v:${v.value}`,
          kind: 'value' as const,
          group: `Values for ${context.column === 'attributes' ? context.field.replace(/^attr\./, '') : context.column}`,
          label: named ? v.label : v.value,
          detail: named ? v.value : undefined,
          named,
          meta: attributeValues ? undefined : formatCompact(v.count),
          from: context.from,
          to: context.to,
          insert,
          // A closed literal: jump past its closing quote.
          caret: context.from + insert.length + (context.openQuote || context.closeQuote ? 0 : 1),
        };
      });
    if (!items.length && valuesLoading) {
      items.push({
        id: 'loading',
        kind: 'snippet',
        group: 'Values',
        label: 'Loading values…',
        from: context.from,
        to: context.from,
        insert: '',
        caret: context.from,
      });
    }
    return items;
  }

  // `timestamp > |`: relative times read better than literals.
  if (context.kind === 'operand' && sqlColumn(context.column)?.type === 'date') {
    const at = input.caret;
    const lead = /\s/.test(draft[at - 1] ?? ' ') ? '' : ' ';
    return [
      ['now() - INTERVAL 1 DAY', 'Last 24 hours'],
      ['now() - INTERVAL 7 DAY', 'Last 7 days'],
      ['now() - INTERVAL 30 DAY', 'Last 30 days'],
      ['today()', 'Today, UTC midnight'],
      [`toDateTime('${isoDay(new Date())} 00:00:00')`, 'A fixed time (UTC)'],
    ].map(([expr = '', detail]) => ({
      id: `t:${expr}`,
      kind: 'snippet' as const,
      group: 'Quick ranges',
      label: expr,
      detail,
      from: at,
      to: at,
      insert: `${lead}${expr} `,
      caret: at + lead.length + expr.length + 1,
    }));
  }
  return [];
}

function sqlIdentItems(input: Input, context: Extract<SqlCompletion, { kind: 'ident' }>): Suggestion[] {
  const { attributes } = input;
  const p = context.prefix;
  const space = input.call ? '' : ' ';
  const items: Suggestion[] = [];
  for (const c of ranked(SQL_COLUMNS, (c) => matchScore(p, c.name, c.description))) {
    const insert = c.name === 'attributes' ? "attributes['" : `${c.name}${space}`;
    items.push({
      id: `c:${c.name}`,
      kind: 'column',
      group: 'Columns',
      label: c.name,
      badge: TYPE_BADGE[c.type],
      detail: c.description,
      meta: c.suggestField ? coverageLabel(input.coverage.get(c.suggestField) ?? 0) : undefined,
      from: context.from,
      to: context.to,
      insert,
      caret: context.from + insert.length,
      keepOpen: true,
    });
  }
  // Attribute keys by their own name (`queue` → attributes['metadata.queue']), or all when typing `attri…`.
  const wantsAll = p.length >= 2 && 'attributes'.startsWith(p.toLowerCase());
  const attrs = wantsAll ? attributes.slice(0, 10) : p.length >= 2 ? ranked(attributes, (a) => matchScore(p, a.key), 8) : [];
  for (const a of attrs) {
    const ref = `attributes['${escapeSql(a.key)}']`;
    const insert = `${ref}${space}`;
    items.push({
      id: `ca:${a.key}`,
      kind: 'attr',
      group: 'Attributes',
      label: ref,
      badge: TYPE_BADGE.attr,
      detail: a.samples.slice(0, 3).join(' · ') || undefined,
      meta: coverageLabel(a.coverage),
      from: context.from,
      to: context.to,
      insert,
      caret: context.from + insert.length,
      keepOpen: true,
    });
  }
  const fns = p ? ranked(SQL_FUNCTIONS, (f) => matchScore(p, f.name)) : SQL_FUNCTIONS.slice(0, 8);
  for (const f of fns) {
    const insert = `${f.name}()`;
    items.push({
      id: `f:${f.name}`,
      kind: 'function',
      group: 'Functions',
      label: f.name,
      badge: TYPE_BADGE.fn,
      detail: sqlSignature(f.name),
      from: context.from,
      to: context.to,
      insert,
      caret: context.from + insert.length - 1,
      keepOpen: true,
    });
  }
  const keywords = p ? SQL_KEYWORDS.filter((k) => k.startsWith(p.toUpperCase()) && k !== p.toUpperCase()) : ['NOT', '('];
  for (const k of keywords) {
    const insert = k === '(' ? '()' : `${k} `;
    items.push({
      id: `kw:${k}`,
      kind: 'keyword',
      group: 'Keywords',
      label: k === '(' ? '( )' : k,
      badge: TYPE_BADGE.kw,
      from: context.from,
      to: context.to,
      insert,
      caret: context.from + insert.length - (k === '(' ? 1 : 0),
      keepOpen: true,
    });
  }
  // Exact-prefix matches first across groups, so `tenant` puts tenant_id above functions mentioning it.
  if (!p) return items;
  return ranked(items, (s) => {
    const score = matchScore(p, s.label.replace(/^attributes\['/, ''), s.detail ?? '');
    return score < 0 ? 5 : score;
  });
}
