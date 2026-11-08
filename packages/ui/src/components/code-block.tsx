import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
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
  /** Called after the copy button copied the code (e.g. to mark a once-only secret as saved). */
  onCopied?: () => void;
}

export function CodeBlock({ code, language = 'text', title, className, maxHeight, copyLabel = 'Copy code', onCopied }: CodeBlockProps) {
  return (
    <div className={cn('group/code relative overflow-hidden rounded-lg border bg-muted/40', className)}>
      {title ? (
        <div className="flex h-9 items-center justify-between border-b px-3 pointer-coarse:h-11">
          <span className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider">{title}</span>
          <CopyButton className="pointer-coarse:size-11" label={copyLabel} onCopied={onCopied} value={code} />
        </div>
      ) : (
        <CopyButton
          className="absolute top-2 end-2 bg-background/80 opacity-70 backdrop-blur group-hover/code:opacity-100 pointer-coarse:size-11"
          label={copyLabel}
          onCopied={onCopied}
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

/**
 * Tabbed snippets (SDK / curl / …) sharing one copy button. Base UI tabs: the strip is one Tab stop, arrow keys switch
 * snippets (automatic activation; the panels are cheap) and the snippet is a labelled tabpanel.
 */
export function CodeTabs({ tabs, className, defaultTab }: { tabs: CodeTab[]; className?: string; defaultTab?: string }) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.id);
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  if (!current) return null;
  return (
    <TabsPrimitive.Root
      className={cn('overflow-hidden rounded-lg border bg-muted/40', className)}
      onValueChange={(value) => setActive(String(value))}
      value={current.id}
    >
      <div className="flex h-9 items-center justify-between border-b ps-1 pe-2 pointer-coarse:h-11">
        <TabsPrimitive.List activateOnFocus aria-label="Snippet language" className="flex h-full items-center">
          {tabs.map((tab) => (
            <TabsPrimitive.Tab
              className={cn(
                'relative h-full cursor-pointer rounded-md px-3 font-medium text-[12px] text-muted-foreground outline-none focus-visible:outline-hidden transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:forced-colors:-outline-offset-2',
                'data-active:text-foreground data-active:after:absolute data-active:after:inset-x-2 data-active:after:bottom-0 data-active:after:h-0.5 data-active:after:rounded-full data-active:after:bg-brand forced-colors:data-active:after:bg-[Highlight]',
              )}
              key={tab.id}
              value={tab.id}
            >
              {tab.label}
            </TabsPrimitive.Tab>
          ))}
        </TabsPrimitive.List>
        <CopyButton className="pointer-coarse:size-11" label="Copy snippet" value={current.code} />
      </div>
      <TabsPrimitive.Panel
        className="overflow-auto p-3.5 font-mono text-[12.5px] leading-relaxed outline-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:forced-colors:-outline-offset-2"
        render={<pre />}
        value={current.id}
      >
        <code>
          <HighlightedCode code={current.code} language={current.language} />
        </code>
      </TabsPrimitive.Panel>
    </TabsPrimitive.Root>
  );
}
