import { createFileRoute, Link } from '@tanstack/react-router';
import { ButtonLink } from '../components/marketing/button-link';
import { CtaBand } from '../components/marketing/cta-band';
import { type FaqItem, FaqList } from '../components/marketing/faq';
import { PlanCards } from '../components/marketing/plan-cards';
import { Rich } from '../components/marketing/rich';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { SelfHostCta } from '../components/marketing/self-host-cta';
import { cloud } from '../content/cloud';
import { pricing } from '../content/pricing';
import { shared } from '../content/shared';
import { SITE } from '../content/site';
import { faqLd, pageHead } from '../lib/seo';

// Words: content/cloud.ts; the pricing section: content/pricing.ts. This file is layout only (content-modules.test.ts).
const faq: FaqItem[] = cloud.faq.items.map(({ q, a, rich, privacyLink }) => ({
  q,
  a,
  body: privacyLink ? (
    <>
      {privacyLink.before}
      <Link className="text-link" to="/legal/privacy">
        {privacyLink.label}
      </Link>
      {privacyLink.after}
    </>
  ) : rich ? (
    <Rich text={rich} />
  ) : undefined,
}));

export const Route = createFileRoute('/cloud')({
  head: () => {
    const head = pageHead('/cloud');
    return { ...head, scripts: [...head.scripts, faqLd(faq.map(({ q, a }) => ({ q, a })))] };
  },
  component: CloudPage,
});

function StatusPanel() {
  return (
    <div className="panel overflow-hidden">
      <p className="border-b bg-[var(--surface-sunken)] px-5 py-3 font-mono text-muted-foreground text-xs uppercase tracking-wider">
        {cloud.status.title}
      </p>
      <dl>
        {cloud.status.rows.map((row) => (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b px-5 py-4 last:border-b-0" key={row.label}>
            <dt className="font-medium">{row.label}</dt>
            <dd className="text-end">
              <span className="block font-medium">{row.value}</span>
              <span className="block text-muted-foreground text-sm">{row.note}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function CloudPage() {
  const { hero } = cloud;
  return (
    <>
      <PageHero
        actions={
          <>
            <ButtonLink size="lg" to="/contact">
              {shared.accessCta}
            </ButtonLink>
            {SITE.signInUrl ? (
              <ButtonLink href={SITE.signInUrl} size="lg" variant="outline">
                {hero.signIn}
              </ButtonLink>
            ) : (
              <SelfHostCta />
            )}
          </>
        }
        aside={<StatusPanel />}
        eyebrow={hero.eyebrow}
        lead={hero.lead}
        title={hero.title}
      />

      <Section id="pricing" labelledBy="pricing-title" tone="sunken">
        <SectionHeader eyebrow={pricing.cloud.eyebrow} id="pricing-title" lead={pricing.cloud.lead} title={pricing.cloud.title} />
        <div className="mt-12">
          <PlanCards dimensions={pricing.dimensions} plans={pricing.plans} />
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
          <ButtonLink to={pricing.cloud.more.to} variant="outline">
            {pricing.cloud.more.label}
          </ButtonLink>
          <p className="text-muted-foreground text-sm">{pricing.cloud.note}</p>
        </div>
      </Section>

      <Section id="faq" labelledBy="faq-title">
        <SectionHeader eyebrow={cloud.faq.eyebrow} id="faq-title" title={cloud.faq.title} />
        <div className="mt-12">
          <FaqList items={faq} />
        </div>
      </Section>

      <CtaBand title={cloud.ctaTitle} />
    </>
  );
}
