import { Skeleton } from '@trailmark/ui/components/ui/skeleton';
import { cn } from '@trailmark/ui/lib/utils';
import type { ClockIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { BrandLockup } from '@/components/brand';

/** Signed-out friendly shell for the invitation (`/accept-invitation/$id`) and invite-link (`/join/$token`) pages. */
export function PublicInviteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-svh flex-col">
      <div
        aria-hidden
        className="tm-grid-bg pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_top,black_15%,transparent_65%)]"
      />
      <header className="relative flex h-16 items-center px-6">
        <BrandLockup />
      </header>
      <main className="relative flex flex-1 items-start justify-center px-4 pt-[8vh] pb-16">
        <div className="tm-fade-in w-full max-w-[420px]">{children}</div>
      </main>
    </div>
  );
}

export function StateCard({
  icon: Icon,
  title,
  description,
  action,
  tone = 'neutral',
  testId,
}: {
  icon: typeof ClockIcon;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  tone?: 'neutral' | 'success' | 'danger' | 'warning';
  testId?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border bg-card p-8 text-center shadow-xs" data-testid={testId}>
      <span
        className={cn(
          'flex size-11 items-center justify-center rounded-xl border',
          tone === 'success' && 'border-outcome-success/30 bg-outcome-success/10 text-outcome-success',
          tone === 'danger' && 'border-destructive/30 bg-destructive/10 text-destructive',
          tone === 'warning' && 'border-outcome-denied/30 bg-outcome-denied/10 text-outcome-denied',
          tone === 'neutral' && 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-5" />
      </span>
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-lg tracking-tight">{title}</h1>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {action ? <div className="flex w-full flex-col items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-end">{children}</dd>
    </div>
  );
}

export function LoadingCard() {
  return (
    <div aria-busy="true" className="flex flex-col items-center gap-4" role="status">
      <Skeleton className="size-12 rounded-xl" />
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-4 w-72" />
      <Skeleton className="mt-2 h-36 w-full rounded-xl" />
      <Skeleton className="h-(--control-size-large) w-full" />
    </div>
  );
}
