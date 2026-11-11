import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

/**
 * A label that swaps between known texts ("Copy" / "Copied", "Show chart" / "Hide chart") without changing its box:
 * every `reserve` text is laid out invisibly in the same grid cell, so the widest one sets the width and the control
 * and its neighbours never move. Only `children` is visible and read by assistive technology.
 */
export function StableText({ children, reserve, className }: { children: ReactNode; reserve: string[]; className?: string }) {
  return (
    <span className={cn('inline-grid justify-items-center', className)}>
      <span className="col-start-1 row-start-1">{children}</span>
      {reserve.map((text, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static list that may repeat a text; never reordered
        <span aria-hidden className="invisible col-start-1 row-start-1" key={index}>
          {text}
        </span>
      ))}
    </span>
  );
}
