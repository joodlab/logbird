import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, eyebrow, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow ? <div className="text-muted-foreground text-xs">{eyebrow}</div> : null}
        <h1 className="truncate font-semibold text-xl tracking-tight">{title}</h1>
        {description ? <p className="max-w-2xl text-muted-foreground text-sm">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Card section with a quiet header row, used across dashboards and settings. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col rounded-xl border bg-card shadow-xs', className)}>
      {title || actions ? (
        <header className="flex min-h-11 items-center justify-between gap-3 border-b px-4 py-2">
          <div className="flex min-w-0 flex-col">
            {title ? <h2 className="truncate font-medium text-[13px]">{title}</h2> : null}
            {description ? <p className="truncate text-muted-foreground text-xs">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn('min-w-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}
