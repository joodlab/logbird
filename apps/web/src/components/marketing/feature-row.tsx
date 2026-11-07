import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { Eyebrow } from './section';

/**
 * A product-tour row: copy on one side, a real screenshot/clip/code sample on the other. `reverse` flips the sides
 * from lg up; on phones the copy always comes first.
 */
export function FeatureRow({
  id,
  eyebrow,
  title,
  children,
  bullets,
  limit,
  visual,
  reverse = false,
  className,
}: {
  id: string;
  eyebrow: string;
  title: ReactNode;
  children: ReactNode;
  bullets?: ReactNode[];
  /** The honest limit that goes with the feature, set in small print. */
  limit?: ReactNode;
  visual: ReactNode;
  reverse?: boolean;
  className?: string;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className={cx('scroll-mt-24 py-14 md:py-20', className)} id={id}>
      <div className="container-site grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)] lg:items-center lg:gap-14">
        <div className={cx('flex flex-col gap-4', reverse && 'lg:order-2')}>
          <Eyebrow>{eyebrow}</Eyebrow>
          <h2 className="font-semibold text-[clamp(1.5rem,2.6vw,2rem)] leading-tight tracking-[-0.025em]" id={`${id}-title`}>
            {title}
          </h2>
          <div className="body-copy text-muted-foreground leading-relaxed">{children}</div>
          {bullets?.length ? (
            <ul className="body-copy flex flex-col gap-2.5 text-sm leading-relaxed">
              {bullets.map((bullet, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static copy, never reordered
                <li className="flex gap-3" key={index}>
                  <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {limit ? <p className="border-s-2 ps-3 text-muted-foreground text-sm leading-relaxed">{limit}</p> : null}
        </div>
        <div className={cx('min-w-0', reverse && 'lg:order-1')}>{visual}</div>
      </div>
    </section>
  );
}

/** A compact card for smaller capabilities (live tail, saved views, ...). */
export function MiniFeature({
  id,
  eyebrow,
  title,
  children,
  limit,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children: ReactNode;
  limit?: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className="panel flex scroll-mt-24 flex-col gap-3 p-6" id={id}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h3 className="h3" id={`${id}-title`}>
        {title}
      </h3>
      <div className="body-copy text-muted-foreground text-sm leading-relaxed">{children}</div>
      {limit ? <p className="mt-auto pt-2 text-muted-foreground text-xs leading-relaxed">{limit}</p> : null}
    </section>
  );
}
