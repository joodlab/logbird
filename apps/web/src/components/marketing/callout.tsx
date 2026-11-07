import { InfoIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';

/** A short, boxed note: a status, a category difference, or where a guarantee stops. Neutral by design. */
export function Callout({ title, children, icon, className }: { title: ReactNode; children: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={cx('panel callout flex gap-4 p-5 md:p-6', className)} role="note">
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-brand">
        {icon ?? <InfoIcon className="size-5" />}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="font-semibold">{title}</p>
        <div className="body-copy text-muted-foreground leading-relaxed">{children}</div>
      </div>
    </div>
  );
}
