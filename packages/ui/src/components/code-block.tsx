import { useMemo, useState } from 'react';
import { type CodeLanguage, highlight, TOKEN_CLASS } from '../lib/highlight';
import { cn } from '../lib/utils';
import { CopyButton } from './copy-button';

export function HighlightedCode({ code, language }: { code: string; language: CodeLanguage }) {
  const tokens = useMemo(() => highlight(code, language), [code, language]);
  return (
    <>
      {tokens.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional and never reorder
        <span className={TOKEN_CLASS[t.type]} key={i}>
          {t.text}
        </span>
      ))}
    </>
  );
}

interface CodeBlockProps {
  code: string;
  language?: CodeLanguage;
  title?: string;
  className?: string;
  /** Max height before the block scrolls. */
  maxHeight?: number;
  copyLabel?: string;
}

export function CodeBlock({ code, language = 'text', title, className, maxHeight, copyLabel = 'Copy code' }: CodeBlockProps) {
  return (
    <div className={cn('group/code relative overflow-hidden rounded-lg border bg-muted/40', className)}>
      {title ? (
        <div className="flex h-9 items-center justify-between border-b px-3">
          <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">{title}</span>
          <CopyButton className="pointer-coarse:size-11" label={copyLabel} value={code} />
        </div>
      ) : (
        <CopyButton
          className="absolute top-2 end-2 bg-background/80 opacity-70 backdrop-blur group-hover/code:opacity-100 pointer-coarse:size-11"
          label={copyLabel}
          value={code}
        />
      )}
      <pre className="overflow-auto p-3.5 font-mono text-[12.5px] leading-relaxed" style={maxHeight ? { maxHeight } : undefined}>
        <code>
          <HighlightedCode code={code} language={language} />
        </code>
      </pre>
    </div>
  );
}

interface CodeTab {
  id: string;
  label: string;
  code: string;
  language: CodeLanguage;
}

/** Tabbed snippets (SDK / curl / …) sharing one copy button. */
export function CodeTabs({ tabs, className, defaultTab }: { tabs: CodeTab[]; className?: string; defaultTab?: string }) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.id);
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  if (!current) return null;
  return (
    <div className={cn('overflow-hidden rounded-lg border bg-muted/40', className)}>
      <div className="flex h-9 items-center justify-between border-b ps-1 pe-2 pointer-coarse:h-11">
        <div className="flex h-full items-center" role="tablist">
          {tabs.map((tab) => (
            <button
              aria-selected={tab.id === current.id}
              className={cn(
                'relative h-full rounded-md px-3 font-medium text-[12px] text-muted-foreground outline-hidden transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset forced-colors:-outline-offset-2',
                tab.id === current.id &&
                  'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand',
              )}
              key={tab.id}
              onClick={() => setActive(tab.id)}
              role="tab"
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
        <CopyButton className="pointer-coarse:size-11" label="Copy snippet" value={current.code} />
      </div>
      <pre className="overflow-auto p-3.5 font-mono text-[12.5px] leading-relaxed">
        <code>
          <HighlightedCode code={current.code} language={current.language} />
        </code>
      </pre>
    </div>
  );
}
