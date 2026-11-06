import { cn } from '@logbird/ui/lib/utils';

/** Logbird bird and newest log entry. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden className={cn('size-6', className)} viewBox="0 0 32 32">
      <rect className="fill-foreground" height="32" rx="8" width="32" />
      <path className="fill-background" d="M6.5 20.5c0-5.8 4.4-10 10-10h1.6a4.6 4.6 0 0 1 4.4 3.2l3 1-3 1c-.9 2.8-3.5 4.8-6.6 4.8H6.5z" />
      <circle className="fill-foreground" cx="19.6" cy="13.9" r="1.35" />
      <path className="stroke-background" d="M6.5 25h11" fill="none" strokeLinecap="round" strokeWidth="2.4" />
      <path d="M21 25h4.5" stroke="var(--brand)" strokeLinecap="round" strokeWidth="2.4" />
    </svg>
  );
}

export function BrandLockup({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold text-[15px] tracking-tight', className)}>
      <BrandMark />
      logbird
    </span>
  );
}
