import type { ReactNode } from 'react';
import { cx as cn } from '../../lib/cx';

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('eyebrow', className)}>{children}</p>;
}

/** A page section on the site grid. `tone="sunken"` gives it the faint footer-like background. */
export function Section({
  id,
  children,
  className,
  tone = 'plain',
  labelledBy,
  compact = false,
}: {
  id?: string;
  children: ReactNode;
  className?: string;
  tone?: 'plain' | 'sunken';
  labelledBy?: string;
  /** Less vertical padding, for sections between product-tour rows. */
  compact?: boolean;
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={cn(
        compact ? 'py-14 md:py-20' : 'py-20 md:py-28',
        tone === 'sunken' && 'border-y bg-[var(--surface-sunken)]',
        'scroll-mt-24',
        className,
      )}
      id={id}
    >
      <div className="container-site">{children}</div>
    </section>
  );
}

/** Eyebrow + h2 + lead, used at the top of most sections. */
export function SectionHeader({
  id,
  eyebrow,
  title,
  lead,
  align = 'start',
  className,
  children,
}: {
  id: string;
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  align?: 'start' | 'center';
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn('flex max-w-3xl flex-col gap-4', align === 'center' && 'mx-auto items-center text-center', className)}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h2 className="h2" id={id}>
        {title}
      </h2>
      {lead ? <p className="lead">{lead}</p> : null}
      {children}
    </div>
  );
}

/** First block of an inner page: eyebrow, h1, lead and optional actions/aside. */
export function PageHero({
  eyebrow,
  title,
  lead,
  actions,
  aside,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  actions?: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('relative overflow-hidden border-b', className)}>
      <div aria-hidden="true" className="ledger-bg pointer-events-none absolute inset-0" />
      <div
        className={cn(
          'container-site relative grid gap-10 pt-16 pb-16 md:pt-24 md:pb-20',
          aside && 'lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-center',
        )}
      >
        <div className="flex max-w-3xl flex-col gap-5">
          {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
          <h1 className="h1">{title}</h1>
          {lead ? <p className="lead max-w-2xl">{lead}</p> : null}
          {actions ? <div className="flex flex-wrap gap-3 pt-2">{actions}</div> : null}
        </div>
        {aside ? <div className="min-w-0">{aside}</div> : null}
      </div>
    </section>
  );
}

/** Small icon + title + text item for feature grids. `compact` puts the icon beside the text. */
export function Feature({ icon, title, children, compact = false }: { icon?: ReactNode; title: ReactNode; children: ReactNode; compact?: boolean }) {
  const badge = icon ? (
    <span aria-hidden="true" className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-brand">
      {icon}
    </span>
  ) : null;
  if (compact) {
    return (
      <div className="flex gap-4">
        {badge}
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold text-base">{title}</h3>
          <div className="body-copy text-muted-foreground text-sm leading-relaxed">{children}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {badge ? <span className="mb-1">{badge}</span> : null}
      <h3 className="h3">{title}</h3>
      <div className="body-copy text-muted-foreground leading-relaxed">{children}</div>
    </div>
  );
}
