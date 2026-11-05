import type { QueryLang } from '@trailmark/contracts';
import { Kbd } from '@trailmark/ui/components/ui/kbd';
import { cn } from '@trailmark/ui/lib/utils';
import { BookmarkIcon, CornerDownLeftIcon, HistoryIcon, Loader2Icon, SparklesIcon, XIcon } from 'lucide-react';
import { Fragment } from 'react';
import type { RecentQuery } from '@/lib/recent-queries';
import { HighlightedText } from './highlighted';
import type { Hint } from './hints';
import type { Suggestion } from './use-completions';

/** The syntax hint row: what the token under the caret expects. */
export function HintRow({ hint, lang, loading }: { hint: Hint | null; lang: QueryLang; loading?: boolean }) {
  if (!hint?.parts.length) return null;
  return (
    <div
      className={cn(
        'flex min-h-7 items-center gap-2 border-b px-3 py-1 text-[11.5px] text-muted-foreground leading-5',
        hint.tone === 'warn' && 'bg-amber-500/[0.06] text-foreground/80',
      )}
      data-slot="query-hint"
    >
      <span className="min-w-0 flex-1 truncate">
        {hint.label ? (
          <span className={cn('me-1.5 font-medium text-foreground/80', hint.tone === 'warn' && 'text-amber-700 dark:text-amber-400')}>
            {hint.label}
          </span>
        ) : null}
        {hint.parts.map((part, i) =>
          typeof part === 'string' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: static, ordered parts
            <Fragment key={i}>{part}</Fragment>
          ) : part.em ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: static, ordered parts
            <code className="rounded bg-muted px-1 py-px font-mono text-[11px]" key={i}>
              {part.code.slice(0, part.em[0])}
              <span className="font-semibold text-foreground underline decoration-brand/60 underline-offset-2">
                {part.code.slice(part.em[0], part.em[1])}
              </span>
              {part.code.slice(part.em[1])}
            </code>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: static, ordered parts
            <code className="rounded bg-muted px-1 py-px font-mono text-[11px]" key={i}>
              <HighlightedText lang={lang} value={part.code} />
            </code>
          ),
        )}
      </span>
      {loading ? <Loader2Icon aria-label="Loading suggestions" className="size-3 shrink-0 animate-spin" /> : null}
    </div>
  );
}

const ICON: Partial<Record<Suggestion['kind'], typeof HistoryIcon>> = { recent: HistoryIcon, view: BookmarkIcon, fix: SparklesIcon };

export function SuggestionPanel({
  suggestions,
  active,
  hint,
  lang,
  listId,
  loading,
  onAccept,
  onHover,
  onRemoveRecent,
}: {
  suggestions: Suggestion[];
  active: number;
  hint: Hint | null;
  lang: QueryLang;
  listId: string;
  loading: boolean;
  onAccept: (s: Suggestion) => void;
  onHover: (index: number) => void;
  onRemoveRecent: (r: RecentQuery) => void;
}) {
  const current = suggestions[active];
  return (
    <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-lg border bg-popover shadow-lg" data-slot="query-suggestions">
      <HintRow hint={hint} lang={lang} loading={loading} />
      {suggestions.length ? (
        <div className="max-h-80 overflow-auto p-1" id={listId} role="listbox">
          {suggestions.map((s, i) => {
            const header = i === 0 || suggestions[i - 1]?.group !== s.group;
            const Icon = ICON[s.kind];
            const code = s.kind === 'term' || s.kind === 'recent' || s.kind === 'fix' || s.kind === 'snippet' || s.label.startsWith("attributes['");
            return (
              <Fragment key={s.id}>
                {header ? (
                  <div className="px-2 pt-1.5 pb-0.5 font-medium text-[10.5px] text-muted-foreground uppercase tracking-wider first:pt-0.5">
                    {s.group}
                  </div>
                ) : null}
                {/* biome-ignore lint/a11y/useFocusableInteractive: listbox options follow the aria-activedescendant pattern; focus stays in the textarea */}
                <div
                  aria-disabled={s.id === 'loading' || undefined}
                  aria-selected={i === active}
                  className={cn(
                    'group/opt flex cursor-pointer items-center gap-2 rounded-md px-2 py-[5px] text-sm',
                    i === active && 'bg-muted',
                    s.id === 'loading' && 'cursor-default text-muted-foreground',
                  )}
                  id={`${listId}-${i}`}
                  onMouseDown={(e) => {
                    // Keep focus (and the caret) in the textarea.
                    e.preventDefault();
                    onAccept(s);
                  }}
                  onMouseMove={() => onHover(i)}
                  role="option"
                >
                  {Icon ? <Icon className={cn('size-3.5 shrink-0 text-muted-foreground', s.kind === 'fix' && 'text-amber-600')} /> : null}
                  {s.id === 'loading' ? <Loader2Icon className="size-3.5 shrink-0 animate-spin" /> : null}
                  <span
                    className={cn(
                      'min-w-0 shrink truncate',
                      s.named || s.kind === 'view' ? 'text-[13px] text-foreground' : 'font-mono text-[12px]',
                      s.kind === 'key' || s.kind === 'column' || s.kind === 'attr' ? 'text-syntax-key' : '',
                      s.kind === 'function' || s.kind === 'keyword' ? 'text-syntax-keyword' : '',
                      s.kind === 'recent' && 'max-w-[70%]',
                    )}
                  >
                    {code && s.id !== 'loading' ? <HighlightedText lang={lang} value={s.label} /> : s.label}
                  </span>
                  {s.badge ? (
                    <span
                      className={cn(
                        'shrink-0 rounded bg-muted px-1 font-mono text-[9.5px] text-muted-foreground uppercase leading-4 tracking-wide',
                        s.badge === 'SQL' && 'border border-syntax-keyword/30 bg-syntax-keyword/10 font-semibold text-syntax-keyword',
                      )}
                    >
                      {s.badge}
                    </span>
                  ) : null}
                  {s.detail ? (
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-muted-foreground text-xs',
                        (s.named || s.kind === 'function' || s.kind === 'view') && 'font-mono text-[11px]',
                      )}
                    >
                      {s.kind === 'view' ? <HighlightedText lang={s.view?.state.lang === 'sql' ? 'sql' : 'query'} value={s.detail} /> : s.detail}
                    </span>
                  ) : (
                    <span className="flex-1" />
                  )}
                  {s.meta ? <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{s.meta}</span> : null}
                  {s.recent ? (
                    <button
                      aria-label={`Forget ${s.recent.q}`}
                      className="-me-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/opt:opacity-100 group-aria-selected/opt:opacity-100"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (s.recent) onRemoveRecent(s.recent);
                      }}
                      tabIndex={-1}
                      type="button"
                    >
                      <XIcon className="size-3" />
                    </button>
                  ) : null}
                </div>
              </Fragment>
            );
          })}
        </div>
      ) : null}
      {suggestions.length ? (
        <div className="hidden items-center gap-3 border-t px-3 py-1 text-[11px] text-muted-foreground sm:flex">
          <span className="flex items-center gap-1">
            <Kbd>↑↓</Kbd> move
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Tab</Kbd> complete
          </span>
          <span className="flex items-center gap-1">
            <Kbd>
              <CornerDownLeftIcon className="size-3" />
            </Kbd>{' '}
            {current?.kind === 'recent' ? 'run this' : 'run'}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Esc</Kbd> close
          </span>
          {current?.recent ? (
            <span className="ms-auto flex items-center gap-1">
              <Kbd>⇧ Del</Kbd> forget
            </span>
          ) : (
            <span className="ms-auto flex items-center gap-1">
              <Kbd>Ctrl Space</Kbd> suggest
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
