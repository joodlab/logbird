import { cn } from '@trailmark/ui/lib/utils';

/** Trailmark mark: a "T" waymark with the accent trail dot. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={cn('size-6', className)} viewBox="0 0 32 32">
      <rect className="fill-foreground" height="32" rx="8" width="32" />
      <path className="stroke-background" d="M9 10h14M16 10v13" fill="none" strokeLinecap="round" strokeWidth="3" />
      <circle cx="23" cy="22" fill="var(--brand)" r="3" />
    </svg>
  );
}

export function BrandLockup({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold text-[15px] tracking-tight', className)}>
      <BrandMark />
      Trailmark
    </span>
  );
}
