import type { ReactNode } from 'react';
import { legal } from '../../content/legal';
import { EFFECTIVE_DATE, effectiveDateLabel } from '../../lib/legal-facts';
import { PageHero } from './section';

export interface LegalSection {
  /** Anchor id, also used by the contents list. */
  id: string;
  title: string;
  body: ReactNode;
}

/**
 * A legal page: hero with the effective date, a contents list and numbered sections. Words: content/legal.ts (this frame)
 * and content/legal-privacy.ts / legal-terms.ts (the pages; marketing/copy/legal-*.md explains the facts behind them);
 * unknown operator facts come from WEB_* settings (src/lib/legal-facts.tsx), so the text renders correctly whether or not
 * they are set. This file is layout only (content-modules.test.ts).
 */
export function LegalDocument({ title, lead, sections }: { title: string; lead: ReactNode; sections: LegalSection[] }) {
  const { document: frame } = legal;
  return (
    <>
      <PageHero
        eyebrow={frame.eyebrow}
        lead={
          <>
            {lead}
            <span className="mt-4 block text-base text-muted-foreground">
              {frame.effective.before}
              <time dateTime={EFFECTIVE_DATE}>{effectiveDateLabel}</time>
              {frame.effective.after}
            </span>
          </>
        }
        title={title}
      />
      <div className="container-site grid gap-12 pb-24 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] lg:gap-16">
        <nav aria-labelledby="legal-contents-title" className="lg:sticky lg:top-[calc(var(--header-h)+1.5rem)] lg:self-start">
          <h2 className="eyebrow" id="legal-contents-title">
            {frame.contents}
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
        <div className="flex max-w-[70ch] flex-col gap-12">
          {sections.map((section, index) => (
            <section aria-labelledby={`${section.id}-title`} className="flex flex-col gap-4" id={section.id} key={section.id}>
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
