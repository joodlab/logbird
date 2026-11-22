import { createFileRoute } from '@tanstack/react-router';
import { CtaBand } from '../components/marketing/cta-band';
import { FaqList } from '../components/marketing/faq';
import { PlanCards } from '../components/marketing/plan-cards';
import { Rich } from '../components/marketing/rich';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { pricing } from '../content/pricing';
import { faqLd, pageHead } from '../lib/seo';

// Words and data: content/pricing.ts. This file is layout only (content-modules.test.ts).
export const Route = createFileRoute('/pricing')({
  head: () => {
    const head = pageHead('/pricing');
    return { ...head, scripts: [...head.scripts, faqLd(pricing.faq.items)] };
  },
  component: PricingPage,
});

function PricingPage() {
  const { hero, plans, dimensions, included, roadmap, faq } = pricing;
  return (
    <>
      <PageHero eyebrow={hero.eyebrow} lead={hero.lead} title={hero.title} />

      <Section id="plans" labelledBy="plans-title">
        <h2 className="sr-only" id="plans-title">
          {hero.eyebrow}
        </h2>
        <PlanCards dimensions={dimensions} plans={plans} />
      </Section>

      <Section id="included" labelledBy="included-title" tone="sunken">
        <SectionHeader eyebrow={included.eyebrow} id="included-title" lead={included.lead} title={included.title} />
        <ul className="mt-10 grid gap-x-10 gap-y-1 md:grid-cols-2">
          {included.features.map((feature) => (
            <li className="flex flex-col gap-1 border-b py-4" key={feature.title}>
              <span className="font-medium">{feature.title}</span>
              <span className="text-muted-foreground text-sm leading-relaxed">
                <Rich text={feature.body} />
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="roadmap" labelledBy="roadmap-title">
        <SectionHeader eyebrow={roadmap.eyebrow} id="roadmap-title" lead={roadmap.lead} title={roadmap.title} />
        <ul className="mt-10 grid gap-x-10 gap-y-3 md:grid-cols-2">
          {roadmap.items.map((item) => (
            <li className="flex gap-3 border-b py-3 text-sm leading-relaxed" key={item}>
              <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full border border-dashed border-muted-foreground" />
              {item}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="faq" labelledBy="faq-title" tone="sunken">
        <SectionHeader eyebrow={faq.eyebrow} id="faq-title" title={faq.title} />
        <div className="mt-10">
          <FaqList items={faq.items} />
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
