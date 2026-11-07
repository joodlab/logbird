import { useCopy } from '@logbird/ui/hooks/use-copy';
import { type CodeLanguage, highlight, TOKEN_CLASS } from '@logbird/ui/lib/highlight';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { cx as cn } from '../../lib/cx';

/**
 * The console's highlighter and syntax tokens, in a lighter shell than `@logbird/ui`'s CodeBlock: the site's copy
 * button needs no tooltip/floating layer, which keeps marketing pages' JavaScript small.
 */
export function Highlighted({ code, language }: { code: string; language: CodeLanguage }) {
  const tokens = useMemo(() => highlight(code, language), [code, language]);
  return (
    <>
      {tokens.map((token, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional and never reorder
        <span className={TOKEN_CLASS[token.type]} key={index}>
          {token.text}
        </span>
      ))}
    </>
  );
}

function CopyCode({ value, label }: { value: string; label: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      aria-label={copied ? 'Copied' : label}
      className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      onClick={() => copy(value)}
      title={label}
      type="button"
    >
      {copied ? <CheckIcon aria-hidden="true" className="size-4 text-outcome-success" /> : <CopyIcon aria-hidden="true" className="size-4" />}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Copied to the clipboard' : ''}
      </span>
    </button>
  );
}

const shell = 'site-code overflow-hidden rounded-xl border bg-[var(--surface)]';
const bar = 'flex h-10 items-center justify-between gap-2 border-b bg-[var(--surface-sunken)] ps-3 pe-1';
const pre = 'overflow-x-auto p-4 font-mono text-[13px] leading-[1.7]';

/** `wrap` soft-wraps long lines instead of scrolling (short commands shown on phones). */
export function SiteCode({
  code,
  language = 'text',
  title,
  className,
  wrap = false,
}: {
  code: string;
  language?: CodeLanguage;
  title?: string;
  className?: string;
  wrap?: boolean;
}) {
  return (
    <div className={cn(shell, className)}>
      <div className={bar}>
        <span className="truncate font-mono text-[11px] text-muted-foreground uppercase tracking-wider">{title ?? language}</span>
        <CopyCode label="Copy code" value={code} />
      </div>
      <pre className={cn(pre, wrap && 'whitespace-pre-wrap break-words')}>
        <code>
          <Highlighted code={code} language={language} />
        </code>
      </pre>
    </div>
  );
}

interface Tab {
  id: string;
  label: string;
  code: string;
  language: CodeLanguage;
}

/** Tabbed snippets with the WAI-ARIA tabs pattern (arrow keys move between tabs). */
export function SiteCodeTabs({ tabs, className }: { tabs: Tab[]; className?: string }) {
  const [active, setActive] = useState(tabs[0]?.id);
  const base = useId();
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  if (!current) {
    return null;
  }
  const move = (delta: number) => {
    const index = tabs.findIndex((tab) => tab.id === current.id);
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next) {
      setActive(next.id);
      document.getElementById(`${base}-tab-${next.id}`)?.focus();
    }
  };
  return (
    <div className={cn(shell, className)}>
      <div className={bar}>
        <div aria-label="Code samples" className="flex h-full items-stretch" role="tablist">
          {tabs.map((tab) => {
            const selected = tab.id === current.id;
            return (
              <button
                aria-controls={`${base}-panel`}
                aria-selected={selected}
                className={cn(
                  'relative px-3 font-medium text-[13px] text-muted-foreground transition-colors hover:text-foreground',
                  selected && 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand',
                )}
                id={`${base}-tab-${tab.id}`}
                key={tab.id}
                onClick={() => setActive(tab.id)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight') {
                    move(1);
                  } else if (event.key === 'ArrowLeft') {
                    move(-1);
                  }
                }}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <CopyCode label="Copy code" value={current.code} />
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable tab panel must be keyboard-focusable (WAI-ARIA tabs, axe scrollable-region-focusable) */}
      <pre aria-labelledby={`${base}-tab-${current.id}`} className={pre} id={`${base}-panel`} role="tabpanel" tabIndex={0}>
        <code>
          <Highlighted code={current.code} language={current.language} />
        </code>
      </pre>
    </div>
  );
}
