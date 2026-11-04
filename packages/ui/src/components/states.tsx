import { AlertTriangleIcon, type LucideIcon, RefreshCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Compact variant for cards and side panels. */
  size?: 'default' | 'sm';
}

/** Calm empty state: what is missing and the next useful step. */
export function EmptyState({ icon: Icon, title, description, children, className, size = 'default' }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'tm-fade-in flex flex-col items-center justify-center text-center',
        size === 'sm' ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-14',
        className,
      )}
    >
      {Icon ? (
        <div
          className={cn(
            'flex items-center justify-center rounded-xl border bg-card text-muted-foreground shadow-xs',
            size === 'sm' ? 'size-9' : 'size-11',
          )}
        >
          <Icon className={size === 'sm' ? 'size-4' : 'size-5'} />
        </div>
      ) : null}
      <div className="flex max-w-sm flex-col gap-1">
        <p className={cn('font-medium text-foreground', size === 'sm' ? 'text-sm' : 'text-[15px]')}>{title}</p>
        {description ? <div className="text-muted-foreground text-sm leading-relaxed">{description}</div> : null}
      </div>
      {children ? <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{children}</div> : null}
    </div>
  );
}

interface ErrorStateProps {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
  size?: 'default' | 'sm';
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Something went wrong while loading this.';
}

export function ErrorState({ title = 'Could not load this', error, onRetry, className, size = 'default' }: ErrorStateProps) {
  return (
    <div
      className={cn('tm-fade-in flex flex-col items-center justify-center gap-3 text-center', size === 'sm' ? 'px-4 py-8' : 'px-6 py-14', className)}
      role="alert"
    >
      <div className="flex size-10 items-center justify-center rounded-xl border border-destructive/20 bg-destructive/5 text-destructive">
        <AlertTriangleIcon className="size-4.5" />
      </div>
      <div className="flex max-w-md flex-col gap-1">
        <p className="font-medium text-sm">{title}</p>
        <p className="text-muted-foreground text-sm">{describe(error)}</p>
      </div>
      {onRetry ? (
        <Button onClick={onRetry} size="sm" variant="outline">
          <RefreshCwIcon />
          Try again
        </Button>
      ) : null}
    </div>
  );
}
