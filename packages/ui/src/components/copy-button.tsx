import { CheckIcon, CopyIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useCopy } from '../hooks/use-copy';
import { cn } from '../lib/utils';
import { StableText } from './stable-text';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface CopyButtonProps extends Omit<ComponentProps<typeof Button>, 'onClick' | 'children'> {
  value: string;
  label?: string;
  /** Show the label next to the icon instead of only in the tooltip. */
  showLabel?: boolean;
  onCopied?: () => void;
}

export function CopyButton({ value, label = 'Copy', showLabel = false, onCopied, className, size, variant = 'ghost', ...props }: CopyButtonProps) {
  const { copied, copy } = useCopy();
  const button = (
    <Button
      aria-label={copied ? 'Copied' : label}
      className={cn('text-muted-foreground hover:text-foreground', className)}
      onClick={async (event) => {
        event.stopPropagation();
        await copy(value);
        onCopied?.();
      }}
      size={size ?? (showLabel ? 'sm' : 'icon-xs')}
      type="button"
      variant={variant}
      {...props}
    >
      {copied ? <CheckIcon className="text-outcome-success" /> : <CopyIcon />}
      {showLabel ? <StableText reserve={[label, 'Copied']}>{copied ? 'Copied' : label}</StableText> : null}
    </Button>
  );
  if (showLabel) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{copied ? 'Copied' : label}</TooltipContent>
    </Tooltip>
  );
}

/** Inline monospace value with a copy affordance that appears on hover/focus. */
export function CopyValue({ value, display, className }: { value: string; display?: string; className?: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      className={cn(
        // min-h-6: a 24px target (WCAG 2.5.8) without changing the text size; the copy icon shows on touch, which has no hover.
        'group/copy inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-sm font-mono text-[12px] text-foreground/90 outline-none focus-visible:outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      onClick={(event) => {
        event.stopPropagation();
        copy(value);
      }}
      title={`Copy ${value}`}
      type="button"
    >
      <span className="truncate">{display ?? value}</span>
      {copied ? (
        <CheckIcon className="size-3 shrink-0 text-outcome-success" />
      ) : (
        <CopyIcon className="size-3 shrink-0 opacity-0 transition-opacity group-hover/copy:opacity-60 group-focus-visible/copy:opacity-60 pointer-coarse:opacity-60" />
      )}
    </button>
  );
}
