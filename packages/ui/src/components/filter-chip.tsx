import type { ComponentProps } from 'react';
import { cn } from '../lib/utils';

/**
 * Toggleable filter chip (type filters, categories, quick options). Sits on the "sm" control height so a row of chips
 * lines up with an sm search field or segmented control next to it. Pass `role="radio"` + `aria-checked` for
 * single-choice groups; otherwise it is a pressed/unpressed toggle.
 */
export function FilterChip({ active, className, type = 'button', ...props }: ComponentProps<'button'> & { active: boolean }) {
  return (
    <button
      aria-pressed={props.role === 'radio' ? undefined : active}
      className={cn(
        "inline-flex h-(--control-size-compact) shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm whitespace-nowrap shadow-xs outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        active
          ? 'border-brand/50 bg-brand/10 font-medium text-brand'
          : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground dark:bg-input/30 dark:hover:bg-input/50',
        className,
      )}
      data-active={active || undefined}
      data-slot="filter-chip"
      type={type}
      {...props}
    />
  );
}
