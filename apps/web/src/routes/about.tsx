import { createFileRoute } from '@tanstack/react-router';
import { ButtonLink } from '../components/marketing/button-link';
import { CtaBand } from '../components/marketing/cta-band';
import { Rich } from '../components/marketing/rich';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { Wordmark } from '../components/marketing/wordmark';
import { about } from '../content/about';
import { pageHead } from '../lib/seo';
import { isReady } from '../lib/site-map';

export const Route = createFileRoute('/about')({ head: () => pageHead('/about'), component: AboutPage });

// Words: content/about.ts. This file is layout only (content-modules.test.ts).
function AboutPage() {
  const { hero, partner, principles, name, build } = about;
  return (
    <>
      <PageHero
        actions={
          <>
            <ButtonLink size="lg" to="/product">
              {hero.tourAction}
            </ButtonLink>
            <ButtonLink size="lg" to="/contact" variant="outline">
              {hero.contactAction}
            </ButtonLink>
          </>
        }
        eyebrow={hero.eyebrow}
        lead={hero.lead}
        title={hero.title}
      />

      <Section labelledBy="partner-title">
        <SectionHeader eyebrow={partner.eyebrow} id="partner-title" lead={partner.lead} title={partner.title} />
      </Section>

      <Section labelledBy="principles-title" tone="sunken">
        <SectionHeader eyebrow={principles.eyebrow} id="principles-title" title={principles.title} />
        <ol className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {principles.items.map((principle, index) => (
            <li className="panel flex flex-col gap-2 p-5 md:p-6" key={principle.title}>
              <span aria-hidden="true" className="font-mono text-brand text-sm tabular-nums">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="font-semibold text-lg">{principle.title}</h3>
              <p className="text-muted-foreground leading-relaxed">
                <Rich text={principle.body} />
              </p>
            </li>
          ))}
        </ol>
      </Section>

      <Section labelledBy="name-title">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
          <SectionHeader eyebrow={name.eyebrow} id="name-title" lead={name.lead} title={name.title} />
          <div className="panel flex items-center justify-center px-6 py-12">
            <Wordmark className="h-14 w-auto max-w-full" />
          </div>
        </div>
      </Section>

      {isReady('/changelog') ? (
        <Section labelledBy="build-title" tone="sunken">
          <SectionHeader eyebrow={build.eyebrow} id="build-title" lead={build.lead} title={build.title}>
            <div className="flex flex-wrap gap-3 pt-2">
              <ButtonLink to="/changelog">{build.changelogAction}</ButtonLink>
              <ButtonLink to="/contact" variant="outline">
                {build.contactAction}
              </ButtonLink>
            </div>
          </SectionHeader>
        </Section>
      ) : null}

      <CtaBand />
    </>
  );
}
