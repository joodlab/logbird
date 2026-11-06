import type { QueryLang } from '@logbird/contracts';
import { Kbd } from '@logbird/ui/components/ui/kbd';
import { SegmentedControl, SegmentedControlItem } from '@logbird/ui/components/ui/segmented-control';
import { Tooltip, TooltipContent, TooltipTrigger } from '@logbird/ui/components/ui/tooltip';
import type { ControlSize } from '@logbird/ui/lib/control';
import { cn } from '@logbird/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { SearchIcon, XIcon } from 'lucide-react';
import { type KeyboardEvent, type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { suggestQuery, viewsQuery } from '@/lib/api/queries';
import { coreField, sqlColumn } from '@/lib/query-catalog';
import type { QueryProblem } from '@/lib/query-error';
import { applyFixes, autoFixes } from '@/lib/query-lint';
import { translateQueryToSql } from '@/lib/query-translate';
import { useRecentQueries } from '@/lib/recent-queries';
import { HighlightedText } from './highlighted';
import { QueryHelp } from './query-help';
import { SuggestionPanel } from './suggestion-panel';
import { type Suggestion, useCompletions } from './use-completions';

/** The /suggest field behind a highlighted field / column suggestion, if it has values worth prefetching. */
function valueSourceFor(s: Suggestion): string | null {
  if (s.kind === 'key') {
    const core = coreField(s.label);
    return core && core.suggest !== 'none' ? core.key : null;
  }
  if (s.kind === 'attr' && !s.label.startsWith("attributes['")) return s.label;
  if (s.kind === 'column') return sqlColumn(s.label)?.suggestField ?? null;
  return null;
}

export interface QueryInputHandle {
  focus: () => void;
}

export interface QueryInputProps {
  projectId: string;
  range: string;
  /** Submitted query (URL state). */
  value: string;
  lang: QueryLang;
  onSubmit: (q: string, lang: QueryLang) => void;
  /** Show the Query | SQL toggle. */
  allowSql?: boolean;
  /** Offer the project's saved views in the suggestion panel (the main explorer, not embedded timelines). */
  views?: boolean;
  /** Server rejection of `value`; its span is underlined while the text is unchanged. */
  problem?: QueryProblem | null;
  placeholder?: string;
  /** Height of one line on the shared control scale (packages/ui lib/control.ts); `sm` in toolbars. */
  size?: ControlSize;
  className?: string;
  ref?: Ref<QueryInputHandle>;
}

const PLACEHOLDER: Record<QueryLang, string> = {
  query: 'action:booking.* attempt:>2 -tenant:*',
  sql: "job_attempt > 2 AND attributes['metadata.channel'] = 'whatsapp'",
};

/*
 * Heights follow the shared control scale (packages/ui lib/control.ts): one line of text plus the border is exactly
 * --query-bar-height (the size's --control-size-* token, 44px on touch). Everything else is derived from it: the
 * inner controls (mode toggle, clear, help) fill the height minus the border and the group inset, and the icons sit on
 * the first line. No hand-set pixel heights.
 */
const SIZE: Record<ControlSize, string> = {
  sm: '[--query-bar-height:var(--control-size-compact)]',
  default: '[--query-bar-height:var(--control-size-default)]',
  lg: '[--query-bar-height:var(--control-size-large)]',
};
const INNER = '[--query-bar-inner:calc(var(--query-bar-height)-2px-2*var(--control-group-inset))]';
/** Mirror and textarea must share every metric that affects wrapping (20px line). */
const TEXT = 'px-2.5 py-[calc((var(--query-bar-height)-2px-1.25rem)/2)] font-mono text-[13px] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]';
/** A 16px icon centred on the first line. */
const FIRST_LINE_ICON = 'mt-[calc((var(--query-bar-height)-2px-1rem)/2)]';

/**
 * Query bar: a transparent auto-growing textarea over a syntax-highlighted mirror (no editor dependency, same
 * metrics, so the caret and selection line up), with a suggestion panel that follows the caret (recent queries,
 * saved views, fields, operators, values ranked by frequency), a syntax hint row, Lucene/KQL conversions, a
 * Query | SQL mode toggle and inline server errors.
 *
 * Keyboard: ↑/↓ move, Tab (or Enter after moving) accepts, Enter runs, Ctrl/⌘+Enter always runs, Esc closes,
 * Ctrl+Space reopens, Shift+Delete forgets the highlighted recent query.
 */
export function QueryInput({
  projectId,
  range,
  value,
  lang,
  onSubmit,
  allowSql = false,
  views: showViews = false,
  problem,
  placeholder,
  size = 'default',
  className,
  ref,
}: QueryInputProps) {
  const [draft, setDraft] = useState(value);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** The user moved through the list (arrows / hover), so Enter means "pick this". */
  const [navigated, setNavigated] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();
  const listId = `qi-list-${lang}`;

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync the draft when the submitted query or its language changes
  useEffect(() => setDraft(value), [value, lang]);

  const recent = useRecentQueries(projectId);
  const views = useQuery({ ...viewsQuery(projectId), enabled: showViews && open, staleTime: 60_000 });
  const completions = useCompletions({
    projectId,
    range,
    lang,
    draft,
    caret,
    open,
    recent: recent.items,
    views: showViews ? views.data : undefined,
  });
  const { suggestions, hint } = completions;
  const showPanel = open && (suggestions.length > 0 || Boolean(hint?.parts.length));
  const showList = showPanel && suggestions.length > 0;
  const activeIndex = Math.min(active, Math.max(0, suggestions.length - 1));
  const activeSuggestion = showList ? suggestions[activeIndex] : undefined;

  // Reset the highlight whenever the list changes shape (new context, group or length).
  const shape = `${completions.context.kind}|${suggestions.length}|${suggestions[0]?.id ?? ''}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the list's shape on purpose
  useEffect(() => {
    setActive(0);
    setNavigated(false);
  }, [shape]);
  useEffect(() => {
    if (showList) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, showList, listId]);

  // Warm the value cache for the highlighted field, so Tab → `field:` shows its values without a spinner.
  const queryClient = useQueryClient();
  const warmField = activeSuggestion ? valueSourceFor(activeSuggestion) : null;
  useEffect(() => {
    if (!warmField) return;
    const timer = setTimeout(() => queryClient.prefetchQuery(suggestQuery(projectId, warmField, '')), 120);
    return () => clearTimeout(timer);
  }, [warmField, projectId, queryClient]);

  /* The caret is restored synchronously after React commits the new text, before the next keystroke. */
  const pendingCaret = useRef<number | null>(null);
  const [edit, setEdit] = useState(0);
  useLayoutEffect(() => {
    const el = inputRef.current;
    const next = pendingCaret.current;
    if (!el || next === null || edit === 0) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(next, next);
    setCaret(next);
  }, [edit]);

  const setText = (text: string, nextCaret: number) => {
    pendingCaret.current = nextCaret;
    setDraft(text);
    setNavigated(false);
    setEdit((n) => n + 1);
  };

  const submit = (q = draft, nextLang = lang) => {
    setOpen(false);
    let text = q.trim();
    // Familiar Lucene / KQL spellings with one clear meaning are converted when the query runs.
    if (nextLang === 'query' && q === draft) {
      const fixes = autoFixes(completions.fixes);
      if (fixes.length) {
        const original = text;
        text = applyFixes(draft, fixes).trim();
        setText(text, text.length);
        toast('Converted to Logbird syntax', {
          description: text,
          action: { label: 'Undo', onClick: () => onSubmit(original, nextLang) },
        });
      }
    }
    if (text) recent.add(text, nextLang);
    onSubmit(text, nextLang);
  };

  const accept = (s: Suggestion) => {
    if (s.id === 'loading') return;
    if (s.view) {
      setOpen(false);
      const v = s.view;
      navigate({
        to: '/p/$projectId/events',
        params: { projectId },
        search: {
          q: v.state.q || undefined,
          lang: v.state.lang === 'sql' ? ('sql' as const) : undefined,
          range: v.state.range,
          cols: v.state.columns?.join(',') || undefined,
          view: v.id,
        },
      });
      return;
    }
    const text = draft.slice(0, s.from) + s.insert + draft.slice(s.to);
    setText(text, s.caret);
    if (s.run) {
      submit(text);
      return;
    }
    // Stay open: the next suggestions (values after `key:`, the next term after a value) follow the caret.
    setOpen(true);
  };

  const switchLang = (next: QueryLang) => {
    if (next === lang) return;
    const text = draft.trim();
    const restore = { label: 'Undo', onClick: () => onSubmit(text, lang) };
    if (!text) {
      submit('', next);
    } else if (next === 'sql') {
      const sql = translateQueryToSql(applyFixes(text, autoFixes(completions.fixes)));
      if (sql) {
        submit(sql, 'sql');
        toast.success('Translated to SQL', { description: sql, action: restore });
      } else {
        submit('', 'sql');
        toast('Query cleared for SQL mode', { description: 'Free text and phrases have no exact SQL equivalent.', action: restore });
      }
    } else {
      submit('', 'query');
      toast('SQL expression cleared', { description: 'SQL is not translated back to the query language.', action: restore });
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (showList && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setNavigated(true);
      const n = suggestions.length;
      setActive((i) => (e.key === 'ArrowDown' ? (Math.min(i, n - 1) + 1) % n : (Math.min(i, n - 1) - 1 + n) % n));
      return;
    }
    if (showList && e.key === 'Delete' && e.shiftKey && activeSuggestion?.recent) {
      e.preventDefault();
      recent.remove(activeSuggestion.recent.q, activeSuggestion.recent.lang);
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && showPanel && (showList || draft.trim())) {
      // While composing, Tab completes and never moves focus (to the mode toggle, where Enter would switch
      // modes). Esc closes the panel first; then Tab leaves the bar as usual.
      e.preventDefault();
      if (activeSuggestion && activeSuggestion.id !== 'loading') accept(activeSuggestion);
      return;
    }
    if (e.key === 'Enter') {
      if (e.shiftKey && lang === 'sql' && !(showList && navigated)) return; // newline
      e.preventDefault();
      const prefix = completions.prefix.toLowerCase();
      const partial =
        Boolean(prefix) &&
        activeSuggestion !== undefined &&
        activeSuggestion.kind !== 'recent' &&
        activeSuggestion.kind !== 'fix' &&
        // A fully typed name (`impersonator` for `impersonator:*`) is not partial: Enter runs.
        activeSuggestion.label.toLowerCase().replace(/:\*?$/, '') !== prefix &&
        activeSuggestion.insert.trim().toLowerCase().replace(/:\*?$/, '') !== prefix;
      if (activeSuggestion && activeSuggestion.id !== 'loading' && !e.metaKey && !e.ctrlKey && (navigated || partial)) {
        accept(activeSuggestion);
        return;
      }
      submit();
      return;
    }
    if (e.key === 'Escape') {
      if (showPanel) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      } else {
        inputRef.current?.blur();
      }
    }
  };

  const showProblem = Boolean(problem) && draft === value;
  const error = showProblem ? { start: problem?.details?.start ?? null, end: problem?.details?.end ?? null } : null;

  return (
    <div className={cn('relative min-w-0 flex-1', SIZE[size], INNER, className)}>
      <div
        className={cn(
          'relative flex min-h-(--query-bar-height) items-start rounded-md border bg-background shadow-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 dark:bg-input/30',
          showProblem && 'border-destructive/50 focus-within:border-destructive/60 focus-within:ring-destructive/20',
        )}
      >
        {allowSql ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <SegmentedControl
                  aria-label="Query language"
                  className="m-(--control-group-inset) shrink-0 flex-nowrap [--segmented-height:var(--query-bar-inner)]!"
                  size="sm"
                  role="group"
                />
              }
            >
              {(['query', 'sql'] as const).map((l) => (
                <SegmentedControlItem
                  active={lang === l}
                  className="px-2 text-[11.5px]"
                  key={l}
                  onClick={() => switchLang(l)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                      e.preventDefault();
                      switchLang(lang === 'sql' ? 'query' : 'sql');
                    }
                  }}
                >
                  {l === 'sql' ? 'SQL' : 'Query'}
                </SegmentedControlItem>
              ))}
            </TooltipTrigger>
            <TooltipContent>{lang === 'sql' ? 'SQL mode: a ClickHouse WHERE expression' : 'Query language (Lucene-like)'}</TooltipContent>
          </Tooltip>
        ) : (
          <SearchIcon className={cn('pointer-events-none ms-3 size-4 shrink-0 text-muted-foreground', FIRST_LINE_ICON)} />
        )}
        {lang === 'sql' ? (
          <span
            className={cn('shrink-0 select-none ps-1.5 font-mono font-semibold text-[10.5px] text-syntax-keyword/70 tracking-wide', FIRST_LINE_ICON)}
          >
            WHERE
          </span>
        ) : null}
        <div className="relative grid max-h-[9.75rem] min-w-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-y-auto overflow-x-hidden">
          <div aria-hidden className={cn(TEXT, 'pointer-events-none [grid-area:1/1]')}>
            {draft ? (
              <>
                <HighlightedText error={error} lang={lang} typingAt={open ? caret : undefined} value={draft} warnings={completions.fixes} />
                {/* Keep a trailing newline measurable so the mirror grows with the textarea. */}
                {'​'}
              </>
            ) : (
              // One line only: a block placeholder plus the newline guard would make the empty bar two lines tall.
              <span className="block truncate whitespace-nowrap text-muted-foreground">{placeholder ?? PLACEHOLDER[lang]}</span>
            )}
          </div>
          <textarea
            aria-activedescendant={showList ? `${listId}-${activeIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={showList}
            aria-invalid={showProblem || undefined}
            aria-label={lang === 'sql' ? 'SQL WHERE expression' : 'Query'}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className={cn(
              TEXT,
              'h-full w-full resize-none overflow-hidden bg-transparent text-transparent caret-foreground outline-none [grid-area:1/1] selection:bg-brand/25 selection:text-transparent',
            )}
            data-lang={lang}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onChange={(e) => {
              setDraft(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              setNavigated(false);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            ref={inputRef}
            role="combobox"
            rows={1}
            spellCheck={false}
            value={draft}
          />
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pe-(--control-group-inset) pt-(--control-group-inset)">
          {draft ? (
            <button
              aria-label="Clear query"
              className="flex size-(--query-bar-inner) items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                setDraft('');
                submit('');
              }}
              type="button"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
          <QueryHelp
            lang={lang}
            onInsert={(example) => {
              setText(example, example.length);
              setOpen(false);
            }}
            projectId={projectId}
          />
          <Kbd className="me-1 hidden md:inline-flex">/</Kbd>
        </div>
      </div>
      {showPanel ? (
        <SuggestionPanel
          active={activeIndex}
          hint={hint}
          lang={lang}
          listId={listId}
          loading={completions.loading}
          onAccept={accept}
          onHover={(i) => {
            if (i !== activeIndex) {
              setActive(i);
              setNavigated(true);
            }
          }}
          onRemoveRecent={(r) => recent.remove(r.q, r.lang)}
          suggestions={suggestions}
        />
      ) : null}
    </div>
  );
}
