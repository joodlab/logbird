import type { ReactNode } from 'react';
import { shared } from '../../content/shared';
import { ButtonLink } from './button-link';
import { LogStack } from './log-stack';
import { SelfHostCta } from './self-host-cta';

/** The closing call to action used at the bottom of most pages. Words: content/shared.ts (ctaBand). */
export function CtaBand({
  title = shared.ctaBand.title,
  body = shared.ctaBand.body,
  note,
  eyebrow,
}: {
  title?: string;
  body?: ReactNode;
  note?: ReactNode;
  /** A short line above the heading, such as the brand line on home. */
  eyebrow?: string;
}) {
  return (
    <section aria-labelledby="cta-title" className="py-20 md:py-24">
      <div className="container-site">
        <div className="panel relative grid gap-10 overflow-hidden p-8 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-center md:p-12">
          <div aria-hidden="true" className="ledger-bg pointer-events-none absolute inset-0 opacity-70" />
          <div className="relative flex flex-col gap-4">
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <h2 className="h2" id="cta-title">
              {title}
            </h2>
            <p className="lead">{body}</p>
            <div className="flex flex-wrap gap-3 pt-2">
              <ButtonLink size="lg" to="/contact">
                {shared.accessCta}
              </ButtonLink>
              <SelfHostCta />
            </div>
            {note ? <p className="text-muted-foreground text-sm">{note}</p> : null}
          </div>
          <LogStack animate={false} className="relative hidden md:flex" limit={3} />
        </div>
      </div>
    </section>
  );
}
