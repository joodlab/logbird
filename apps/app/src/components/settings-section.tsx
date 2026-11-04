import { cn } from '@trailmark/ui/lib/utils';
import type { ReactNode } from 'react';

/** Settings block: title + explanation on the left (desktop), controls on the right. */
export function SettingsSection({
  title,
  description,
  children,
  footer,
  tone = 'default',
  className,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  tone?: 'default' | 'danger';
  className?: string;
}) {
  return (
    <section className={cn('overflow-hidden rounded-xl border bg-card shadow-xs', tone === 'danger' && 'border-destructive/30', className)}>
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-1">
          <h2 className={cn('font-semibold text-[15px]', tone === 'danger' && 'text-destructive')}>{title}</h2>
          {description ? <div className="max-w-2xl text-muted-foreground text-sm">{description}</div> : null}
        </div>
        {children}
      </div>
      {footer ? (
        <div className={cn('flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3', tone === 'danger' && 'bg-destructive/[0.03]')}>
          {footer}
        </div>
      ) : null}
    </section>
  );
}
