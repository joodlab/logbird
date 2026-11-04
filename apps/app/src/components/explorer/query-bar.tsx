import { useDebouncedValue } from '@tanstack/react-pacer';
import { useQuery } from '@tanstack/react-query';
import type { EntityKind } from '@trailmark/contracts';
import { Kbd } from '@trailmark/ui/components/ui/kbd';
import { cn } from '@trailmark/ui/lib/utils';
import { CornerDownLeftIcon, SearchIcon, XIcon } from 'lucide-react';
import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api/client';
import { facetQuery } from '@/lib/api/queries';
import { canonicalField, facetFieldFor, QUERY_FIELDS, type QueryToken, tokenAt, tokenize } from '@/lib/query-language';

export interface QueryBarHandle {
  focus: () => void;
}

interface QueryBarProps {
  projectId: string;
  range: string;
  value: string;
  onSubmit: (q: string) => void;
  placeholder?: string;
  className?: string;
}

interface Suggestion {
  key: string;
  insert: string;
  label: string;
  detail?: string;
  count?: number;
  kind: 'field' | 'value';
}

const ENTITY_FIELDS: Record<string, EntityKind> = { actor: 'actor', tenant: 'tenant', executor: 'executor', target: 'target' };

function tokenClass(t: QueryToken): string {
  switch (t.kind) {
    case 'field':
      return t.negated ? 'text-outcome-failure' : '';
    case 'phrase':
      return 'text-syntax-string';
    case 'operator':
      return 'font-semibold text-syntax-keyword';
    case 'paren':
      return 'text-syntax-punct';
    default:
      return t.negated ? 'text-outcome-failure' : 'text-foreground';
  }
}

function HighlightedQuery({ value }: { value: string }) {
  const tokens = useMemo(() => tokenize(value), [value]);
  return (
    <>
      {tokens.map((t) => {
        if (t.kind === 'field') {
          const sep = t.raw.indexOf(':');
          return (
            <span className={tokenClass(t)} key={t.start}>
              <span className={t.negated ? 'text-outcome-failure' : 'text-syntax-key'}>{t.raw.slice(0, sep)}</span>
              <span className="text-syntax-punct">:</span>
              <span className={t.raw.slice(sep + 1).startsWith('"') ? 'text-syntax-string' : 'text-foreground'}>{t.raw.slice(sep + 1)}</span>
            </span>
          );
        }
        return (
          <span className={tokenClass(t)} key={t.start}>
            {t.raw}
          </span>
        );
      })}
      {/* Keep a trailing space measurable so the caret overlay lines up. */}
      <span> </span>
    </>
  );
}

/**
 * Single-line query editor: a transparent <input> over a highlighted mirror, with field and
 * value autocomplete (values from facets for low-cardinality fields, entities for ids).
 */
export function QueryBar({ projectId, range, value, onSubmit, placeholder, className, ref }: QueryBarProps & { ref?: Ref<QueryBarHandle> }) {
  const [draft, setDraft] = useState(value);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);
  useEffect(() => setDraft(value), [value]);

  const current = tokenAt(draft, caret);
  const fieldContext = current?.kind === 'field' && caret > current.start + current.raw.indexOf(':') ? current : undefined;
  const field = fieldContext ? canonicalField(fieldContext.field ?? '') : undefined;
  const partial = (fieldContext ? (fieldContext.value ?? '') : current?.kind === 'text' ? (current.value ?? '') : '').toLowerCase();
  const [debouncedPartial] = useDebouncedValue(partial, { wait: 150 });

  const facetField = field ? facetFieldFor(field) : undefined;
  const entityKind = field ? ENTITY_FIELDS[field] : undefined;
  const facetValues = useQuery({
    ...facetQuery(projectId, facetField ?? 'action', range, '', 30),
    enabled: open && Boolean(facetField) && !entityKind,
  });
  const entityValues = useQuery({
    queryKey: ['qb-entities', projectId, entityKind, debouncedPartial],
    queryFn: ({ signal }) => api.entities.list(projectId, { kind: entityKind ?? 'actor', q: debouncedPartial || undefined, limit: 8 }, signal),
    enabled: open && Boolean(entityKind),
    staleTime: 30_000,
  });

  const suggestions: Suggestion[] = useMemo(() => {
    if (!open) return [];
    if (fieldContext && field) {
      if (entityKind) {
        return (entityValues.data?.data ?? []).map((e) => {
          const raw = entityKind === 'target' ? e.id.slice(e.id.indexOf(':') + 1) : e.id;
          return {
            key: e.id,
            insert: raw,
            label: e.name || raw,
            detail: entityKind === 'target' ? e.id : e.id,
            count: e.events,
            kind: 'value' as const,
          };
        });
      }
      return (facetValues.data?.values ?? [])
        .filter((v) => !partial || v.value.toLowerCase().includes(partial) || v.label.toLowerCase().includes(partial))
        .slice(0, 10)
        .map((v) => ({
          key: v.value,
          insert: v.value,
          label: v.value,
          detail: v.label !== v.value ? v.label : undefined,
          count: v.count,
          kind: 'value' as const,
        }));
    }
    const prefix = current?.kind === 'text' ? (current.value ?? '').toLowerCase() : '';
    return QUERY_FIELDS.filter((f) => !prefix || f.key.startsWith(prefix))
      .slice(0, prefix ? 8 : 12)
      .map((f) => ({ key: f.key, insert: f.key.endsWith('.') ? f.key : `${f.key}:`, label: f.key, detail: f.description, kind: 'field' as const }));
  }, [open, fieldContext, field, entityKind, entityValues.data, facetValues.data, partial, current]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlighted option whenever the suggestion list changes
  useEffect(() => setActive(0), [suggestions.length, field]);

  const accept = (s: Suggestion) => {
    let next: string;
    let nextCaret: number;
    if (s.kind === 'field') {
      const start = current?.kind === 'text' ? current.start : caret;
      const end = current?.kind === 'text' ? current.end : caret;
      const neg = current?.negated ? '-' : '';
      next = `${draft.slice(0, start)}${neg}${s.insert}${draft.slice(end)}`;
      nextCaret = start + neg.length + s.insert.length;
    } else if (fieldContext) {
      const sep = fieldContext.raw.indexOf(':');
      const valueStart = fieldContext.start + sep + 1;
      const quoted = /[\s()"]/.test(s.insert) ? `"${s.insert.replaceAll('"', '\\"')}"` : s.insert;
      const after = draft.slice(fieldContext.end);
      const spacer = after.startsWith(' ') ? '' : ' ';
      next = `${draft.slice(0, valueStart)}${quoted}${spacer}${after}`;
      nextCaret = valueStart + quoted.length + 1;
    } else {
      return;
    }
    setDraft(next);
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
    if (s.kind === 'value') setOpen(false);
  };

  const submit = (q = draft) => {
    setOpen(false);
    onSubmit(q.trim());
  };

  const showMenu = open && suggestions.length > 0;

  return (
    <div className={cn('relative min-w-0 flex-1', className)}>
      <div
        className={cn(
          'relative flex h-9 items-center rounded-lg border bg-background shadow-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 dark:bg-input/30',
        )}
      >
        <SearchIcon className="pointer-events-none ms-3 size-4 shrink-0 text-muted-foreground" />
        <div className="relative h-full min-w-0 flex-1 overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 start-0 flex items-center whitespace-pre px-2.5 font-mono text-[13px]"
            style={{ transform: `translateX(${-scrollLeft}px)` }}
          >
            {draft ? <HighlightedQuery value={draft} /> : <span className="text-muted-foreground">{placeholder ?? 'Search events…'}</span>}
          </div>
          <input
            aria-activedescendant={showMenu ? `qb-opt-${active}` : undefined}
            aria-autocomplete="list"
            aria-controls="qb-listbox"
            aria-expanded={showMenu}
            aria-label="Query"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="absolute inset-0 h-full w-full bg-transparent px-2.5 font-mono text-[13px] text-transparent caret-foreground outline-none selection:bg-brand/25 selection:text-transparent"
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onChange={(e) => {
              setDraft(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              setOpen(true);
            }}
            onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (showMenu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % suggestions.length : (i - 1 + suggestions.length) % suggestions.length));
                return;
              }
              if (showMenu && e.key === 'Tab') {
                e.preventDefault();
                const s = suggestions[active];
                if (s) accept(s);
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                const s = suggestions[active];
                if (showMenu && s && (s.kind === 'value' || (current?.kind === 'text' && !e.metaKey && !e.ctrlKey))) {
                  accept(s);
                  return;
                }
                submit();
                return;
              }
              if (e.key === 'Escape') {
                if (showMenu) {
                  e.stopPropagation();
                  setOpen(false);
                } else {
                  inputRef.current?.blur();
                }
              }
            }}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
            ref={inputRef}
            role="combobox"
            spellCheck={false}
            value={draft}
          />
        </div>
        {draft ? (
          <button
            aria-label="Clear query"
            className="me-1 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => {
              setDraft('');
              submit('');
            }}
            type="button"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : null}
        <Kbd className="me-2 hidden md:inline-flex">/</Kbd>
      </div>
      {showMenu ? (
        <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-lg border bg-popover shadow-lg" id="qb-listbox" role="listbox">
          <div className="flex items-center justify-between border-b px-3 py-1.5 text-[11px] text-muted-foreground">
            <span>{fieldContext ? `Values for ${field}` : 'Fields'}</span>
            <span className="flex items-center gap-1">
              <Kbd>↑↓</Kbd> select <Kbd>Tab</Kbd> complete{' '}
              <Kbd>
                <CornerDownLeftIcon className="size-3" />
              </Kbd>{' '}
              run
            </span>
          </div>
          <div className="max-h-72 overflow-auto p-1">
            {suggestions.map((s, i) => (
              // biome-ignore lint/a11y/useFocusableInteractive: listbox options follow the aria-activedescendant pattern; focus stays in the input
              <div
                aria-selected={i === active}
                className={cn('flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-sm', i === active && 'bg-muted')}
                id={`qb-opt-${i}`}
                key={s.key}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(s);
                }}
                onMouseEnter={() => setActive(i)}
                role="option"
              >
                <span className={cn('shrink-0 font-mono text-[12px]', s.kind === 'field' ? 'text-syntax-key' : 'text-foreground')}>{s.label}</span>
                {s.detail ? <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{s.detail}</span> : <span className="flex-1" />}
                {s.count !== undefined ? (
                  <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{s.count.toLocaleString('en-US')}</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
