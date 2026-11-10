import type { ReactNode } from 'react';
import { EFFECTIVE_DATE, effectiveDateLabel } from '../../lib/legal-facts';
import { PageHero } from './section';

export interface LegalSection {
  /** Anchor id, also used by the contents list. */
  id: string;
  title: string;
  body: ReactNode;
}

/**
 * A legal page: hero with the effective date, a contents list and numbered sections. Copy lives in the route
 * (marketing/copy/legal-*.md explains the facts behind it); unknown operator facts come from WEB_* settings
 * (src/lib/legal-facts.ts), so the text renders correctly whether or not they are set.
 */
export function LegalDocument({ title, lead, sections }: { title: string; lead: ReactNode; sections: LegalSection[] }) {
  return (
    <>
      <PageHero
        eyebrow="Legal"
        lead={
          <>
            {lead}
            <span className="mt-4 block text-base text-muted-foreground">
              Effective <time dateTime={EFFECTIVE_DATE}>{effectiveDateLabel}</time>.
            </span>
          </>
        }
        title={title}
      />
      <div className="container-site grid gap-12 pb-24 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] lg:gap-16">
        <nav aria-labelledby="legal-contents-title" className="lg:sticky lg:top-[calc(var(--header-h)+1.5rem)] lg:self-start">
          <h2 className="eyebrow" id="legal-contents-title">
            Contents
          </h2>
          <ol className="mt-4 flex flex-col gap-2 text-sm">
            {sections.map((section, index) => (
              <li key={section.id}>
                <a className="text-muted-foreground hover:text-foreground" href={`#${section.id}`}>
                  {index + 1}. {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div className="legal-body flex max-w-3xl flex-col gap-12">
          {sections.map((section, index) => (
            <section aria-labelledby={`${section.id}-title`} className="flex scroll-mt-24 flex-col gap-4" id={section.id} key={section.id}>
              <h2 className="font-semibold text-xl tracking-[-0.02em]" id={`${section.id}-title`}>
                {index + 1}. {section.title}
              </h2>
              <div className="body-copy flex flex-col gap-4 leading-relaxed">{section.body}</div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

/** A bulleted list in a legal section. */
export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-2 ps-5 marker:text-muted-foreground">{children}</ul>;
}
