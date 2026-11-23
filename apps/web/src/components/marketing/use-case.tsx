import { shared } from '../../content/shared';
import type { UseCase, UseCaseSection } from '../../content/use-cases/types';
import { isReady } from '../../lib/site-map';
import { ButtonLink } from './button-link';
import { SiteCode } from './code';
import { CtaBand } from './cta-band';
import { ScreenshotFrame } from './frame';
import { Guarantees } from './guarantees';
import { Rich } from './rich';
import { PageHero, Section, SectionHeader } from './section';

/** A use-case page from its content module (content/use-cases/*.ts): layout only. */
export function UseCasePage({ page }: { page: UseCase }) {
  return (
    <>
      <PageHero eyebrow={page.hero.eyebrow} lead={<Rich text={page.hero.lead} />} title={page.hero.title} />
      {page.sections.map((section, index) => (
        <UseCaseBlock key={section.id} section={section} sunken={index % 2 === 1} />
      ))}
      <CtaBand />
    </>
  );
}

function UseCaseBlock({ section, sunken }: { section: UseCaseSection; sunken: boolean }) {
  // An element id, not wording.
  const titleId = [section.id, 'title'].join('-');
  const body = (
    <div className="flex min-w-0 flex-col gap-8">
      <SectionHeader eyebrow={section.eyebrow} id={titleId} lead={section.lead ? <Rich text={section.lead} /> : undefined} title={section.title} />
      {section.points ? (
        <ul className="flex flex-col gap-4">
          {section.points.map((point) => (
            <li className="flex gap-3 text-sm leading-relaxed" key={point.title}>
              <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
              <span>
                <strong className="font-medium">
                  <Rich text={point.title} />
                </strong>
                <span className="text-muted-foreground">
                  {'. '}
                  <Rich text={point.body} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {section.steps ? (
        <ol className="flex flex-col gap-8">
          {section.steps.map((step, index) => (
            <li className="flex min-w-0 gap-4" key={step.title}>
              <span
                aria-hidden="true"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border bg-background font-mono text-sm"
              >
                {index + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-3 pt-1">
                <h3 className="font-semibold">
                  <Rich text={step.title} />
                </h3>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  <Rich text={step.body} />
                </p>
                {step.code ? <SiteCode code={step.code.code} language={step.code.language} title={step.code.title} /> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {section.limit ? (
        <p className="panel border-s-2 border-s-brand p-4 text-sm leading-relaxed">
          <strong className="font-medium">{section.limit.label}</strong>
          <span className="text-muted-foreground">
            {': '}
            <Rich text={section.limit.text} />
          </span>
        </p>
      ) : null}
    </div>
  );
  return (
    <Section id={section.id} labelledBy={titleId} tone={sunken ? 'sunken' : undefined}>
      {section.visual ? (
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] lg:items-start">
          {body}
          <ScreenshotFrame
            caption={section.visual.caption}
            id={section.visual.id}
            label={section.visual.label}
            sizes="(min-width: 1024px) 520px, calc(100vw - 2rem)"
            zoomLabel={section.visual.zoom ? `${shared.openFullSize}: ${section.visual.label}` : undefined}
          />
        </div>
      ) : (
        <div className="max-w-3xl">{body}</div>
      )}
      {section.limits ? (
        <div className="mt-10">
          <Guarantees headers={section.limits.headers} items={section.limits.rows} questions={section.limits.questions} />
        </div>
      ) : null}
      {section.cta && isReady(section.cta.to) ? (
        <div className="mt-10">
          <ButtonLink hash={section.cta.hash} search={section.cta.search} to={section.cta.to} variant="outline">
            {section.cta.label}
          </ButtonLink>
        </div>
      ) : null}
    </Section>
  );
}
