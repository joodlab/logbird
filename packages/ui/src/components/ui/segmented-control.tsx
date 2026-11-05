import type { ComponentProps } from 'react';
import { type ControlDensity, type ControlSize, controlSize } from '../../lib/control';
import { cn } from '../../lib/utils';

/** The shell owns the outer size (the control scale, lib/control.ts); items use only its remaining inner height. */
function SegmentedControl({
  className,
  size,
  density,
  ...props
}: ComponentProps<'div'> & {
  size?: ControlSize;
  /** @deprecated use `size` ("compact" = "sm"). */
  density?: ControlDensity;
}) {
  const resolved = controlSize(size, density);
  return (
    <div
      data-slot="segmented-control"
      data-size={resolved}
      data-density={resolved === 'sm' ? 'compact' : 'default'}
      className={cn(
        'inline-flex min-w-0 flex-wrap items-stretch gap-0.5 rounded-lg bg-muted p-(--control-group-inset) [--segmented-height:var(--control-size-default)] data-[size=sm]:[--segmented-height:var(--control-size-compact)] data-[size=lg]:[--segmented-height:var(--control-size-large)] min-h-(--segmented-height)',
        className,
      )}
      {...props}
    />
  );
}

function SegmentedControlItem({ className, active, ...props }: ComponentProps<'button'> & { active: boolean }) {
  return (
    <button
      type="button"
      data-slot="segmented-control-item"
      aria-pressed={active}
      className={cn(
        "inline-flex min-h-[calc(var(--segmented-height)-2*var(--control-group-inset))] min-w-[calc(var(--segmented-height)-2*var(--control-group-inset))] flex-auto cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 text-center font-medium text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export { SegmentedControl, SegmentedControlItem };
