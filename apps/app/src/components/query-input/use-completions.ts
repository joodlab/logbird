import { useDebouncedValue } from '@tanstack/react-pacer';
import { useQuery } from '@tanstack/react-query';
import type { QueryLang, SuggestResponse } from '@trailmark/contracts';
import { useMemo } from 'react';
import { fieldsQuery, suggestQuery } from '@/lib/api/queries';
import { formatCompact } from '@/lib/format';
import {
  attributeKey,
  attributeQueryKey,
  coreField,
  QUERY_KEYS,
  SQL_COLUMNS,
  SQL_FUNCTIONS,
  SQL_KEYWORDS,
  sqlColumn,
  TYPE_BADGE,
} from '@/lib/query-catalog';
import { type QueryCompletion, queryCompletionAt, quoteIfNeeded } from '@/lib/query-language';
import { type SqlCompletion, sqlCompletionAt } from '@/lib/sql-language';

export interface Suggestion {
  id: string;
  kind: 'key' | 'term' | 'value' | 'snippet' | 'column' | 'function' | 'keyword' | 'attr';
  label: string;
  /** Small type badge (str, num, attr, fn…). */
  badge?: string;
  detail?: string;
  /** Right-aligned count / coverage. */
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
}

export interface Completions {
  suggestions: Suggestion[];
  /** Menu header, e.g. "Values for actor.name". */
  title: string;
  /** What the user typed for the current completion (Enter accepts only partial matches). */
  prefix: string;
  loading: boolean;
  context: QueryCompletion | SqlCompletion;
}

/** 0 = prefix, 1 = word-segment prefix (`name` → actor.name / actor_name), 2 = substring, 3 = in description, -1 = no match. */
export function matchScore(prefix: string, label: string, extra = ''): number {
  if (!prefix) return 0;
  const p = prefix.toLowerCase();
  const l = label.toLowerCase();
  if (l.startsWith(p)) return 0;
  if (l.split(/[._]/).some((seg) => seg.startsWith(p))) return 1;
  if (l.includes(p)) return 2;
  if (extra && p.length >= 3 && extra.toLowerCase().includes(p)) return 3;
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

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const escapeSql = (v: string) => v.replace(/[\\']/g, '\\$&');

/** Where values for a completion come from: a /suggest field, or nothing. */
function suggestField(context: QueryCompletion | SqlCompletion): string | null {
  if (context.kind !== 'value') return null;
  if (/^(attr|attributes)\./.test(context.field)) return context.field;
  const core = coreField(context.field);
  if (core) return core.suggest === 'none' ? null : core.key;
  return context.field; // bare attribute key (metadata.channel)
}

export function useCompletions({
  projectId,
  range,
  lang,
  draft,
  caret,
  open,
}: {
  projectId: string;
  range: string;
  lang: QueryLang;
  draft: string;
  caret: number;
  open: boolean;
}): Completions {
  const context = useMemo<QueryCompletion | SqlCompletion>(
    () => (lang === 'sql' ? sqlCompletionAt(draft, caret, (column) => sqlColumn(column)?.suggestField) : queryCompletionAt(draft, caret)),
    [lang, draft, caret],
  );

  const wantsAttributes = open && (context.kind === 'key' || context.kind === 'ident' || context.kind === 'attrKey');
  const fields = useQuery({ ...fieldsQuery(projectId, range), enabled: wantsAttributes, staleTime: 5 * 60_000 });
  const attributes = useMemo(
    () =>
      (fields.data?.data ?? [])
        .filter((f) => f.kind === 'attribute')
        .map((f) => ({ key: attributeKey(f.key), coverage: f.coverage, samples: f.samples }))
        .sort((a, b) => b.coverage - a.coverage),
    [fields.data],
  );

  const valueField = open ? suggestField(context) : null;
  const rawPrefix = context.kind === 'value' ? context.prefix : '';
  const [debouncedPrefix] = useDebouncedValue(rawPrefix, { wait: 150 });
  const values = useQuery({
    ...suggestQuery(projectId, valueField ?? '', debouncedPrefix),
    enabled: Boolean(valueField),
    // Keep the previous list while the next prefix loads (no flicker), but never across fields.
    placeholderData: (previous: SuggestResponse | undefined) => (previous?.field === valueField ? previous : undefined),
  });

  return useMemo<Completions>(() => {
    const empty = { suggestions: [], title: '', prefix: '', loading: false, context };
    if (!open) return empty;
    const after = (to: number) => draft.slice(to);
    const coverage = (c: number) => (c >= 0.995 ? '100%' : c >= 0.01 ? `${Math.round(c * 100)}%` : '<1%');

    /* ---------------- values (both modes) ---------------- */
    if (context.kind === 'value') {
      const p = context.prefix.toLowerCase();
      const fetched = (values.data?.field === valueField ? values.data?.values : undefined) ?? [];
      const matching = fetched.filter((v) => !p || v.value.toLowerCase().includes(p) || v.label.toLowerCase().includes(p));
      const sql = lang === 'sql';
      const sqlContext = context as Extract<SqlCompletion, { kind: 'value' }>;
      const queryContext = context as Extract<QueryCompletion, { kind: 'value' }>;
      const items: Suggestion[] = [];
      const core = sql ? undefined : coreField(context.field);
      const ordered = core?.type === 'number' || core?.type === 'date';
      // /suggest counts for attributes are the key's frequency, not the value's: don't show them per value.
      const attributeValues = valueField !== null && !coreField(valueField);

      if (!sql && !queryContext.op && ordered && !p) {
        const snippets =
          core?.type === 'date'
            ? [
                { insert: `>${daysAgo(1)}`, detail: 'After a date (UTC midnight)' },
                { insert: `[${daysAgo(7)} TO ${today()}]`, detail: 'Between two dates, inclusive' },
                { insert: '>', detail: 'After … (YYYY-MM-DD or ISO-8601)', keepOpen: true },
              ]
            : [
                { insert: '>', detail: 'Greater than', keepOpen: true },
                { insert: '>=', detail: 'Greater than or equal', keepOpen: true },
                { insert: '<', detail: 'Less than', keepOpen: true },
                { insert: '[1 TO 5]', detail: 'Range, inclusive — use { } to exclude, * for open' },
              ];
        for (const s of snippets) {
          const space = s.keepOpen || /^[\s)]/.test(after(context.to)) ? '' : ' ';
          items.push({
            id: `snip:${s.insert}`,
            kind: 'snippet',
            label: s.insert,
            detail: s.detail,
            from: context.from,
            to: context.to,
            insert: s.insert + space,
            caret: context.from + s.insert.length + space.length,
            keepOpen: s.keepOpen,
          });
        }
      }
      if (!sql && !queryContext.op && !ordered && (p === '' || p === '*')) {
        const space = queryContext.inGroup || /^[\s)]/.test(after(context.to)) ? '' : ' ';
        items.push({
          id: 'presence',
          kind: 'value',
          label: '*',
          detail: core?.presence ?? `Has ${context.field} (non-empty)`,
          from: context.from,
          to: context.to,
          insert: `*${space}`,
          caret: context.from + 1 + space.length,
        });
      }
      for (const v of matching) {
        let insert: string;
        let caretPos: number;
        if (sql) {
          insert = `${escapeSql(v.value)}${sqlContext.closeQuote ? "'" : ''}`;
          caretPos = context.from + insert.length;
        } else {
          const quoted = quoteIfNeeded(v.value);
          const space = queryContext.inGroup || /^[\s)]/.test(after(context.to)) ? '' : ' ';
          insert = quoted + space;
          caretPos = context.from + insert.length;
        }
        const named = Boolean(v.label && v.label !== v.value);
        items.push({
          id: `v:${v.value}`,
          kind: 'value',
          label: named ? v.label : v.value,
          detail: named ? v.value : undefined,
          named,
          meta: attributeValues ? undefined : formatCompact(v.count),
          from: context.from,
          to: context.to,
          insert,
          caret: caretPos,
        });
      }
      return {
        suggestions: items,
        title: `Values for ${context.field}`,
        prefix: context.prefix,
        loading: Boolean(valueField) && values.isFetching,
        context,
      };
    }

    /* ---------------- query-language keys ---------------- */
    if (context.kind === 'key') {
      const raw = context.prefix;
      const typedAttr = /^(attr|attributes)\./.exec(raw)?.[0];
      const p = typedAttr ? raw.slice(typedAttr.length) : raw;
      const replacesColon = draft[context.to - 1] === ':';
      const keyItem = (key: string, partial: Omit<Suggestion, 'from' | 'to' | 'insert' | 'caret' | 'label'>): Suggestion => {
        const insert = `${key}:`;
        return { ...partial, label: key, from: context.from, to: context.to, insert, caret: context.from + insert.length, keepOpen: true };
      };
      const core = typedAttr
        ? []
        : ranked(QUERY_KEYS, (f) => bestScore([f.key, ...(f.aliases ?? [])].map((k) => matchScore(p, k, f.description)))).map((f) =>
            keyItem(f.key, { id: `k:${f.key}`, kind: 'key', badge: TYPE_BADGE[f.type], detail: f.description }),
          );
      const shortcuts: Suggestion[] = replacesColon
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
              label: term,
              detail: f.presence,
              from: context.from,
              to: context.to,
              insert: term + space,
              caret: context.from + term.length + space.length,
            };
          });
      const attrs = ranked(attributes, (a) => matchScore(p, a.key, a.samples.join(' ')), 40).map((a) =>
        keyItem(typedAttr ? `${typedAttr}${a.key}` : attributeQueryKey(a.key), {
          id: `a:${a.key}`,
          kind: 'attr',
          badge: TYPE_BADGE.attr,
          detail: a.samples.length ? a.samples.slice(0, 3).join(' · ') : undefined,
          meta: coverage(a.coverage),
        }),
      );
      const keywords =
        raw && raw === raw.toUpperCase() && /^[A-Z]+$/.test(raw)
          ? ['OR', 'AND', 'NOT']
              .filter((k) => k.startsWith(raw) && k !== raw)
              .map((k) => ({
                id: `kw:${k}`,
                kind: 'keyword' as const,
                label: k,
                badge: TYPE_BADGE.kw,
                from: context.from,
                to: context.to,
                insert: `${k} `,
                caret: context.from + k.length + 1,
              }))
          : [];
      // With no prefix: the core catalog, then the project's most common attributes.
      const suggestions = [...keywords, ...core, ...shortcuts, ...attrs];
      return {
        suggestions: rankKeysFirst(suggestions, p),
        title: typedAttr ? 'Attributes' : 'Fields',
        prefix: raw,
        loading: fields.isFetching && !fields.data,
        context,
      };
    }

    /* ---------------- SQL identifiers ---------------- */
    if (context.kind === 'ident') {
      const p = context.prefix;
      const items: Suggestion[] = [];
      for (const c of ranked(SQL_COLUMNS, (c) => matchScore(p, c.name, c.description))) {
        const insert = c.name === 'attributes' ? "attributes['" : c.name;
        items.push({
          id: `c:${c.name}`,
          kind: 'column',
          label: c.name,
          badge: TYPE_BADGE[c.type],
          detail: c.description,
          from: context.from,
          to: context.to,
          insert,
          caret: context.from + insert.length,
          keepOpen: c.name === 'attributes',
        });
      }
      if (p.length >= 2 && 'attributes'.startsWith(p.toLowerCase())) {
        for (const a of attributes.slice(0, 8)) {
          const insert = `attributes['${escapeSql(a.key)}']`;
          items.push({
            id: `ca:${a.key}`,
            kind: 'attr',
            label: insert,
            badge: TYPE_BADGE.attr,
            detail: a.samples.slice(0, 3).join(' · ') || undefined,
            meta: coverage(a.coverage),
            from: context.from,
            to: context.to,
            insert,
            caret: context.from + insert.length,
          });
        }
      }
      const fns = p ? ranked(SQL_FUNCTIONS, (f) => matchScore(p, f.name)) : SQL_FUNCTIONS.slice(0, 8);
      for (const f of fns) {
        const insert = `${f.name}()`;
        items.push({
          id: `f:${f.name}`,
          kind: 'function',
          label: f.name,
          badge: TYPE_BADGE.fn,
          detail: f.signature,
          from: context.from,
          to: context.to,
          insert,
          caret: context.from + insert.length - 1,
          keepOpen: true,
        });
      }
      if (p) {
        for (const k of SQL_KEYWORDS.filter((k) => k.startsWith(p.toUpperCase()) && k !== p.toUpperCase())) {
          items.push({
            id: `kw:${k}`,
            kind: 'keyword',
            label: k,
            badge: TYPE_BADGE.kw,
            from: context.from,
            to: context.to,
            insert: `${k} `,
            caret: context.from + k.length + 1,
          });
        }
      }
      return { suggestions: rankKeysFirst(items, p), title: 'Columns & functions', prefix: p, loading: false, context };
    }

    /* ---------------- SQL attributes['…'] ---------------- */
    if (context.kind === 'attrKey') {
      const items = ranked(attributes, (a) => matchScore(context.prefix, a.key, a.samples.join(' '))).map((a): Suggestion => {
        // An open string gets its closers; a closed one keeps them and the caret jumps past `']`.
        const insert = `${escapeSql(a.key)}${context.closeQuote ? `'${context.closeBracket ? ']' : ''}` : ''}`;
        const skip = context.closeQuote ? 0 : 1 + (context.closeBracket ? 0 : 1);
        return {
          id: `ak:${a.key}`,
          kind: 'attr',
          label: a.key,
          badge: TYPE_BADGE.attr,
          detail: a.samples.slice(0, 3).join(' · ') || undefined,
          meta: coverage(a.coverage),
          from: context.from,
          to: context.to,
          insert,
          caret: context.from + insert.length + skip,
        };
      });
      return { suggestions: items, title: 'Attribute keys', prefix: context.prefix, loading: fields.isFetching && !fields.data, context };
    }
    return empty;
  }, [open, context, draft, lang, values.data, values.isFetching, valueField, attributes, fields.isFetching, fields.data]);
}

function bestScore(scores: number[]): number {
  const ok = scores.filter((s) => s >= 0);
  return ok.length ? Math.min(...ok) : -1;
}

/** Exact-prefix matches first (stable), so typing `tenant` puts tenant/tenant.name above actor-ish matches. */
function rankKeysFirst(items: Suggestion[], prefix: string): Suggestion[] {
  if (!prefix) return items;
  return ranked(items, (s) => {
    const score = matchScore(prefix, s.label.replace(/^attributes\['/, ''), s.detail ?? '');
    return score < 0 ? 4 : score;
  });
}
