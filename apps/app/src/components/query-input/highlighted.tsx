import type { QueryLang } from '@logbird/contracts';
import { cn } from '@logbird/ui/lib/utils';
import { type ReactNode, useMemo } from 'react';
import { highlightQuery, markErrorSpan, type SegmentClass } from '@/lib/query-language';
import { highlightSql } from '@/lib/sql-language';

/*
 * Bold/italic would change glyph advance in some monospace fonts and push the caret out of line with
 * the transparent textarea on top, so weight is the only emphasis used (all mono fonts we ship keep
 * semibold at the same width).
 */
const CLASS: Record<SegmentClass, string> = {
  plain: '',
  key: 'text-syntax-key',
  ident: 'text-syntax-key',
  negation: 'text-outcome-failure',
  punct: 'text-syntax-punct',
  operator: 'text-syntax-keyword',
  keyword: 'font-semibold text-syntax-keyword',
  function: 'text-syntax-keyword',
  value: 'text-foreground',
  string: 'text-syntax-string',
  number: 'text-syntax-number',
  regex: 'text-syntax-string',
  wildcard: 'font-semibold text-syntax-number',
  unknown: 'text-destructive underline decoration-destructive/60 decoration-dotted underline-offset-[3px]',
  comment: 'text-syntax-comment underline decoration-destructive/60 decoration-dotted underline-offset-[3px]',
};

const ERROR = 'rounded-[2px] bg-destructive/10 underline decoration-destructive decoration-wavy decoration-[1.5px] underline-offset-[3px]';
/* Lucene / KQL spelling the bar converts: a calm dotted underline, not an error. */
const WARN = 'underline decoration-amber-500/80 decoration-dotted decoration-[1.5px] underline-offset-[3px]';

export interface HighlightError {
  start: number | null;
  end: number | null;
}

/** Zero-width error position (e.g. "expected a value here"): a small caret under the gap. */
function CaretMarker() {
  return (
    <span aria-hidden className="relative inline-block h-[1lh] w-0 align-top">
      <span className="absolute start-0 bottom-[-3px] -translate-x-1/2 border-x-[4px] border-x-transparent border-b-[5px] border-b-destructive" />
    </span>
  );
}

/**
 * Syntax-highlighted query or SQL expression. Used as the query bar's mirror (under a transparent
 * textarea), in the cheat-sheet, saved views and docs.
 */
export function HighlightedText({
  value,
  lang = 'query',
  error,
  typingAt,
  warnings,
}: {
  value: string;
  lang?: QueryLang;
  error?: HighlightError | null;
  /** Caret offset while editing: the word being typed is not flagged as unknown yet. */
  typingAt?: number;
  /** Spans to underline as "will be converted" (query-lint fixes). */
  warnings?: readonly { start: number; end: number }[];
}) {
  const nodes = useMemo(() => {
    const base = lang === 'sql' ? highlightSql(value) : highlightQuery(value);
    const start = error?.start ?? null;
    const end = error?.end ?? null;
    let segments = markErrorSpan(base, start, end);
    for (const w of warnings ?? []) segments = markErrorSpan(segments, w.start, w.end, 'warn');
    // Zero-width spans, and spans that point past the text (e.g. "unexpected end"), draw a caret instead.
    const caretAt = start !== null && (end === null || end <= start || start >= value.length) ? Math.min(start, value.length) : null;
    const out: ReactNode[] = [];
    for (const s of segments) {
      if (caretAt !== null && caretAt === s.start) out.push(<CaretMarker key="caret" />);
      out.push(
        <span
          className={cn(CLASS[s.cls === 'unknown' && typingAt === s.end ? 'ident' : s.cls], s.warn && WARN, s.error && ERROR)}
          key={`${s.start}-${s.end}`}
        >
          {value.slice(s.start, s.end)}
        </span>,
      );
    }
    if (caretAt !== null && caretAt >= value.length) out.push(<CaretMarker key="caret" />);
    return out;
  }, [value, lang, error?.start, error?.end, typingAt, warnings]);
  return <>{nodes}</>;
}

/** Back-compat name used by the docs page. */
export function HighlightedQuery({ value }: { value: string }) {
  return <HighlightedText value={value} />;
}
