import { Link } from '@tanstack/react-router';
import type { QueryLang } from '@trailmark/contracts';
import { Popover, PopoverContent, PopoverTrigger } from '@trailmark/ui/components/ui/popover';
import { cn } from '@trailmark/ui/lib/utils';
import { ArrowUpRightIcon, CircleHelpIcon, ShieldCheckIcon } from 'lucide-react';
import { useState } from 'react';
import { HighlightedText } from './highlighted';

interface Example {
  code: string;
  note: string;
}

const QUERY_SECTIONS: { title: string; rows: Example[] }[] = [
  {
    title: 'Match',
    rows: [
      { code: 'action:booking.*', note: 'Prefix with a trailing *' },
      { code: 'outcome:failure -env:staging', note: 'Terms AND together; - excludes' },
      { code: 'actor.name:"Lina Haddad"', note: 'Quote values with spaces' },
      { code: 'impersonator:* -tenant:*', note: 'Present / missing' },
      { code: 'metadata.channel:whatsapp', note: 'Any attribute key' },
    ],
  },
  {
    title: 'Compare',
    rows: [
      { code: 'attempt:>2', note: '> >= < <= on numbers and dates' },
      { code: 'attempt:[2 TO 5]', note: 'Inclusive range; { } excludes, * is open' },
      { code: 'occurredAt:>2026-11-01', note: 'Dates: YYYY-MM-DD or ISO-8601 (UTC)' },
    ],
  },
  {
    title: 'Patterns & groups',
    rows: [
      { code: 'action:/booking\\.(created|cancelled)/', note: 'RE2 regex, whole value' },
      { code: 'action:(booking.created OR booking.cancelled)', note: 'Any of these values' },
      { code: '-outcome:(failure OR denied)', note: 'None of these values' },
      { code: '(outcome:failure OR outcome:denied) attempt:>1', note: 'OR, AND, NOT and parentheses' },
    ],
  },
  {
    title: 'Coming from Lucene / Kibana / Datadog',
    rows: [
      { code: 'impersonator:*', note: '_exists_:impersonator is converted' },
      { code: 'tenant:biz_7', note: 'tenant = biz_7 (KQL) is converted' },
      { code: '-outcome:success', note: 'outcome != success and !outcome:success too' },
      { code: 'attempt:>=2', note: 'attempt >= 2 is converted' },
      { code: 'a AND b', note: '&& and || work; operators are upper-case' },
    ],
  },
];

const SQL_SECTIONS: { title: string; rows: Example[] }[] = [
  {
    title: 'Columns & attributes',
    rows: [
      { code: 'job_attempt > 2', note: 'Any allowed column' },
      { code: "attributes['metadata.channel'] = 'whatsapp'", note: 'Attributes are Map(String, String)' },
      { code: "outcome IN ('failure', 'denied')", note: 'IN, LIKE, ILIKE, BETWEEN…' },
      { code: "toFloat64OrNull(attributes['duration_ms']) > 500", note: 'Cast attribute values to compare' },
    ],
  },
  {
    title: 'Arrays, strings, time',
    rows: [
      { code: "has(target_types, 'booking')", note: 'Array membership' },
      { code: "arrayExists(x -> startsWith(x, 'bk_'), target_ids)", note: 'Lambdas over arrays' },
      { code: "match(action, '^booking\\\\.')", note: 'RE2 regex' },
      { code: 'toHour(timestamp) BETWEEN 9 AND 17', note: 'Date functions (UTC)' },
    ],
  },
];

/** Syntax cheat-sheet for the active mode. Clicking an example puts it in the query bar. */
export function QueryHelp({ lang, projectId, onInsert }: { lang: QueryLang; projectId: string; onInsert: (example: string) => void }) {
  const [open, setOpen] = useState(false);
  const sections = lang === 'sql' ? SQL_SECTIONS : QUERY_SECTIONS;
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <button
            aria-label={lang === 'sql' ? 'SQL syntax help' : 'Query syntax help'}
            className="flex size-(--query-bar-inner) items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            type="button"
          />
        }
      >
        <CircleHelpIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[min(32rem,70svh)] w-[min(30rem,calc(100vw-2rem))] gap-3 overflow-y-auto p-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium text-sm">{lang === 'sql' ? 'SQL WHERE expression' : 'Query syntax'}</span>
          <span className="text-[11px] text-muted-foreground">Click an example to use it</span>
        </div>
        {sections.map((section) => (
          <div className="flex flex-col gap-0.5" key={section.title}>
            <span className="px-1 font-medium text-[10.5px] text-muted-foreground uppercase tracking-wider">{section.title}</span>
            {section.rows.map((row) => (
              <button
                className="group flex flex-col items-start gap-0.5 rounded-md px-1.5 py-1 text-start outline-none hover:bg-muted focus-visible:bg-muted sm:flex-row sm:items-baseline sm:gap-3"
                key={row.code}
                onClick={() => {
                  onInsert(row.code);
                  setOpen(false);
                }}
                type="button"
              >
                <code className="min-w-0 shrink-0 font-mono text-[12px] sm:max-w-[62%] sm:truncate">
                  <HighlightedText lang={lang} value={row.code} />
                </code>
                <span className="min-w-0 text-[11.5px] text-muted-foreground sm:ms-auto sm:truncate sm:text-end">{row.note}</span>
              </button>
            ))}
          </div>
        ))}
        {lang === 'sql' ? (
          <div className="flex gap-2 rounded-md border bg-muted/40 p-2 text-[11.5px] text-muted-foreground leading-relaxed">
            <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" />
            <p>
              Only a <span className="font-medium text-foreground">WHERE expression</span> is accepted. Trailmark wraps it in its own query, scoped to
              this project and time range, and runs it read-only. Subqueries, table functions, SETTINGS/FORMAT, comments and semicolons are rejected —
              a free-form SQL console is intentionally not offered.
            </p>
          </div>
        ) : null}
        <Link
          className={cn('inline-flex items-center gap-1 self-start px-1 text-[12px] text-muted-foreground hover:text-foreground')}
          hash="query"
          onClick={() => setOpen(false)}
          params={{ projectId }}
          to="/p/$projectId/docs"
        >
          Full reference
          <ArrowUpRightIcon className="size-3" />
        </Link>
      </PopoverContent>
    </Popover>
  );
}
