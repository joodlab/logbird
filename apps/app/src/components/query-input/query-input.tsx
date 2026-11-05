import type { QueryLang } from '@trailmark/contracts';
import { Kbd } from '@trailmark/ui/components/ui/kbd';
import { SegmentedControl, SegmentedControlItem } from '@trailmark/ui/components/ui/segmented-control';
import { Tooltip, TooltipContent, TooltipTrigger } from '@trailmark/ui/components/ui/tooltip';
import { cn } from '@trailmark/ui/lib/utils';
import { CornerDownLeftIcon, Loader2Icon, SearchIcon, XIcon } from 'lucide-react';
import { type KeyboardEvent, type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { QueryProblem } from '@/lib/query-error';
import { translateQueryToSql } from '@/lib/query-translate';
import { HighlightedText } from './highlighted';
import { QueryHelp } from './query-help';
import { type Suggestion, useCompletions } from './use-completions';

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
  /** Server rejection of `value`; its span is underlined while the text is unchanged. */
  problem?: QueryProblem | null;
  placeholder?: string;
  className?: string;
  ref?: Ref<QueryInputHandle>;
}

const PLACEHOLDER: Record<QueryLang, string> = {
  query: 'action:booking.* attempt:>2 -tenant:*',
  sql: "job_attempt > 2 AND attributes['metadata.channel'] = 'whatsapp'",
};

/* Mirror and textarea must share every metric that affects wrapping. */
const TEXT = 'px-2.5 py-[7px] font-mono text-[13px] leading-5 whitespace-pre-wrap break-words';

/**
 * Query bar: a transparent auto-growing textarea over a syntax-highlighted mirror (no editor
 * dependency, same metrics, so the caret and selection line up), with key/value autocomplete,
 * a Query | SQL mode toggle and inline server errors.
 */
export function QueryInput({ projectId, range, value, lang, onSubmit, allowSql = false, problem, placeholder, className, ref }: QueryInputProps) {
  const [draft, setDraft] = useState(value);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** The user moved through the list (arrows / hover), so Enter means "pick this". */
  const [navigated, setNavigated] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listId = `qi-list-${lang}`;

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync the draft when the submitted query or its language changes
  useEffect(() => setDraft(value), [value, lang]);

  const completions = useCompletions({ projectId, range, lang, draft, caret, open });
  const { suggestions } = completions;
  const showMenu = open && suggestions.length > 0;
  const activeSuggestion = suggestions[Math.min(active, suggestions.length - 1)];

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlight whenever the list changes shape
  useEffect(() => setActive(0), [completions.title, completions.context.kind, suggestions.length]);
  useEffect(() => {
    if (showMenu) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, showMenu, listId]);

  const setText = (text: string, nextCaret: number) => {
    setDraft(text);
    setNavigated(false);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  const accept = (s: Suggestion) => {
    setText(draft.slice(0, s.from) + s.insert + draft.slice(s.to), s.caret);
    setOpen(Boolean(s.keepOpen));
  };

  const submit = (q = draft, nextLang = lang) => {
    setOpen(false);
    onSubmit(q.trim(), nextLang);
  };

  const switchLang = (next: QueryLang) => {
    if (next === lang) return;
    const text = draft.trim();
    const restore = { label: 'Undo', onClick: () => onSubmit(text, lang) };
    if (!text) {
      submit('', next);
    } else if (next === 'sql') {
      const sql = translateQueryToSql(text);
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
    if (showMenu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setNavigated(true);
      const n = suggestions.length;
      setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n));
      return;
    }
    if (showMenu && e.key === 'Tab' && !e.shiftKey && activeSuggestion) {
      e.preventDefault();
      accept(activeSuggestion);
      return;
    }
    if (e.key === 'Enter') {
      if (e.shiftKey && lang === 'sql' && !(showMenu && navigated)) return; // newline
      e.preventDefault();
      const prefix = completions.prefix.toLowerCase();
      const partial =
        Boolean(prefix) &&
        activeSuggestion &&
        activeSuggestion.label.toLowerCase() !== prefix &&
        activeSuggestion.insert.trim().toLowerCase() !== prefix;
      if (showMenu && activeSuggestion && !e.metaKey && !e.ctrlKey && (navigated || partial)) {
        accept(activeSuggestion);
        return;
      }
      submit();
      return;
    }
    if (e.key === 'Escape') {
      if (showMenu) {
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
    <div className={cn('relative min-w-0 flex-1', className)}>
      <div
        className={cn(
          'relative flex min-h-9 items-start rounded-lg border bg-background shadow-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 dark:bg-input/30',
          showProblem && 'border-destructive/50 focus-within:border-destructive/60 focus-within:ring-destructive/20',
        )}
      >
        {allowSql ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <SegmentedControl
                  aria-label="Query language"
                  className="m-[3px] shrink-0 flex-nowrap [--segmented-height:1.75rem]"
                  density="compact"
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
          <SearchIcon className="pointer-events-none ms-3 mt-[9px] size-4 shrink-0 text-muted-foreground" />
        )}
        {lang === 'sql' ? (
          <span className="mt-[9px] shrink-0 select-none ps-1.5 font-mono font-semibold text-[10.5px] text-syntax-keyword/70 tracking-wide">
            WHERE
          </span>
        ) : null}
        <div className="relative grid max-h-[9.75rem] min-w-0 flex-1 overflow-y-auto">
          <div aria-hidden className={cn(TEXT, 'pointer-events-none [grid-area:1/1]')}>
            {draft ? (
              <HighlightedText error={error} lang={lang} value={draft} />
            ) : (
              <span className="block truncate whitespace-nowrap text-muted-foreground">{placeholder ?? PLACEHOLDER[lang]}</span>
            )}
            {/* Keep a trailing newline measurable so the mirror grows with the textarea. */}
            {'​'}
          </div>
          <textarea
            aria-activedescendant={showMenu ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={showMenu}
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
        <div className="flex shrink-0 items-center gap-0.5 pe-1 pt-[3px]">
          {draft ? (
            <button
              aria-label="Clear query"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
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
      {showMenu ? (
        <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-lg border bg-popover shadow-lg" id={listId} role="listbox">
          <div className="flex items-center justify-between gap-3 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              {completions.title}
              {completions.loading ? <Loader2Icon className="size-3 animate-spin" /> : null}
            </span>
            <span className="hidden shrink-0 items-center gap-1 sm:flex">
              <Kbd>↑↓</Kbd> select <Kbd>Tab</Kbd> complete{' '}
              <Kbd>
                <CornerDownLeftIcon className="size-3" />
              </Kbd>{' '}
              run
            </span>
          </div>
          <div className="max-h-72 overflow-auto p-1">
            {suggestions.map((s, i) => (
              // biome-ignore lint/a11y/useFocusableInteractive: listbox options follow the aria-activedescendant pattern; focus stays in the textarea
              <div
                aria-selected={i === active}
                className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm', i === active && 'bg-muted')}
                id={`${listId}-${i}`}
                key={s.id}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(s);
                }}
                onMouseMove={() => {
                  if (i !== active) {
                    setActive(i);
                    setNavigated(true);
                  }
                }}
                role="option"
              >
                <span
                  className={cn(
                    'min-w-0 shrink truncate',
                    s.named ? 'text-[13px] text-foreground' : 'font-mono text-[12px]',
                    s.kind === 'key' || s.kind === 'column' || s.kind === 'attr' ? 'text-syntax-key' : '',
                    s.kind === 'function' || s.kind === 'keyword' || s.kind === 'snippet' ? 'text-syntax-keyword' : '',
                  )}
                >
                  {s.kind === 'term' || s.kind === 'attr' ? <HighlightedText lang={lang} value={s.label} /> : s.label}
                </span>
                {s.badge ? (
                  <span className="shrink-0 rounded bg-muted px-1 font-mono text-[9.5px] text-muted-foreground uppercase leading-4 tracking-wide">
                    {s.badge}
                  </span>
                ) : null}
                {s.detail ? (
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-muted-foreground text-xs',
                      (s.named || s.kind === 'function') && 'font-mono text-[11px]',
                    )}
                  >
                    {s.detail}
                  </span>
                ) : (
                  <span className="flex-1" />
                )}
                {s.meta ? <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{s.meta}</span> : null}
              </div>
            ))}
          </div>
          {completions.context.kind === 'key' ? (
            <div className="hidden border-t px-3 py-1.5 text-[11px] text-muted-foreground sm:block">
              Terms are ANDed. Use <span className="font-mono font-semibold text-syntax-keyword">OR</span> and parentheses for either:{' '}
              <span className="font-mono">(outcome:failure OR outcome:denied) attempt:&gt;1</span>
            </div>
          ) : completions.context.kind === 'ident' ? (
            <div className="hidden border-t px-3 py-1.5 text-[11px] text-muted-foreground sm:block">
              A WHERE expression only — <span className="font-mono">Shift</span>+<span className="font-mono">Enter</span> for a new line.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
