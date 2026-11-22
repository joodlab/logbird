import { createFileRoute } from '@tanstack/react-router';
import { BoxesIcon, GitBranchIcon, SearchIcon, ShieldCheckIcon } from 'lucide-react';
import { ButtonLink } from '../components/marketing/button-link';
import { SiteCode, SiteCodeTabs } from '../components/marketing/code';
import { CtaBand } from '../components/marketing/cta-band';
import { ScreenshotFrame } from '../components/marketing/frame';
import { Guarantees } from '../components/marketing/guarantees';
import { LogStack } from '../components/marketing/log-stack';
import { Rich } from '../components/marketing/rich';
import { Eyebrow, Feature, Section, SectionHeader } from '../components/marketing/section';
import { SelfHostCta } from '../components/marketing/self-host-cta';
import { home } from '../content/home';
import type { Cta, Item } from '../content/site';
import { pageHead } from '../lib/seo';
import { isReady } from '../lib/site-map';

export const Route = createFileRoute('/')({ head: () => pageHead('/'), component: HomePage });

// Words: content/home.ts. This file is layout only (content-modules.test.ts).

function CtaButton({ cta, variant = 'outline' }: { cta: Cta; variant?: 'default' | 'outline' | 'ghost' | 'link' }) {
  if (!isReady(cta.to)) return null;
  return (
    <ButtonLink hash={cta.hash} search={cta.search} to={cta.to} variant={variant}>
      {cta.label}
    </ButtonLink>
  );
}

/** Titled points, one per line: the title, then the sentence that proves it. */
function Points({ items }: { items: Item[] }) {
  return (
    <ul className="flex flex-col gap-4">
      {items.map((item) => (
        <li className="flex gap-3 text-sm leading-relaxed" key={item.title}>
          <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
          <span>
            <strong className="font-medium">
              <Rich text={item.title} />
            </strong>
            <span className="text-muted-foreground">
              {'. '}
              <Rich text={item.body} />
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function HomePage() {
  const { explorer, customers, evidence, operators, developers, hosting, guarantees, closing } = home;
  const { access } = customers;
  return (
    <>
      <Hero />

      <section aria-label={explorer.label} className="pb-8">
        <div className="container-site">
          <ScreenshotFrame caption={explorer.caption} id="explorer" label={explorer.frameLabel} />
        </div>
      </section>

      <Section id="customers" labelledBy="customers-title">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start">
          <div className="flex flex-col gap-8">
            <SectionHeader eyebrow={customers.eyebrow} id="customers-title" lead={<Rich text={customers.lead} />} title={customers.title} />
            <Points items={access.points} />
            <p className="panel border-s-2 border-s-brand p-4 text-sm leading-relaxed">
              <strong className="font-medium">{customers.limitLabel}</strong>
              <span className="text-muted-foreground">
                {': '}
                <Rich text={access.limit} />
              </span>
            </p>
            <div>
              <CtaButton cta={customers.cta} />
            </div>
          </div>
          <ScreenshotFrame
            caption={customers.screenshot.caption}
            id="tenant"
            label={customers.screenshot.label}
            sizes="(min-width: 1024px) 620px, calc(100vw - 2rem)"
          />
        </div>
      </Section>

      <Section id="evidence" labelledBy="evidence-title" tone="sunken">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-center">
          <SectionHeader eyebrow={evidence.eyebrow} id="evidence-title" lead={evidence.lead} title={evidence.title} />
          <ScreenshotFrame
            caption={evidence.screenshot.caption}
            id="retention"
            label={evidence.screenshot.label}
            sizes="(min-width: 1024px) 620px, calc(100vw - 2rem)"
          />
        </div>
        <div className="mt-12">
          <Guarantees headers={evidence.headers} items={evidence.rows} />
        </div>
        <div className="mt-10">
          <CtaButton cta={evidence.cta} />
        </div>
      </Section>

      <Section id="operators" labelledBy="operators-title">
        <SectionHeader eyebrow={operators.eyebrow} id="operators-title" lead={operators.lead} title={operators.title} />
        <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-start">
          <ScreenshotFrame
            caption={operators.screenshot.caption}
            id="event-sheet"
            label={operators.screenshot.label}
            sizes="(min-width: 1024px) 680px, calc(100vw - 2rem)"
          />
          <div className="grid gap-6">
            {(
              [
                [operators.features.search, <SearchIcon className="size-4" key="icon" />],
                [operators.features.entities, <BoxesIcon className="size-4" key="icon" />],
                [operators.features.operations, <GitBranchIcon className="size-4" key="icon" />],
              ] as const
            ).map(([feature, icon]) => (
              <Feature compact icon={icon} key={feature.title} title={feature.title}>
                <Rich text={feature.body} />
              </Feature>
            ))}
          </div>
        </div>
        <div className="mt-10">
          <CtaButton cta={operators.cta} />
        </div>
      </Section>

      <Section id="developers" labelledBy="developers-title" tone="sunken">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start">
          <div className="flex flex-col gap-8">
            <SectionHeader eyebrow={developers.eyebrow} id="developers-title" lead={developers.lead} title={developers.title} />
            <ul className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
              {developers.items.map((item) => (
                <li className="text-sm leading-relaxed" key={item.title}>
                  <strong className="font-medium">
                    <Rich text={item.title} />
                  </strong>
                  <span className="text-muted-foreground">
                    <Rich text={item.body} />
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {developers.otherStacks.text}{' '}
              {developers.otherStacks.link ? (
                <>
                  <a className="text-link font-mono" href={developers.otherStacks.link.href}>
                    {developers.otherStacks.link.label}
                  </a>
                  .
                </>
              ) : (
                <Rich text={developers.otherStacks.privateNote} />
              )}
            </p>
            <div>
              <CtaButton cta={developers.cta} />
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <SiteCodeTabs tabs={developers.code.map((tab) => ({ ...tab, language: 'ts' as const }))} />
            <p className="text-muted-foreground text-sm">{developers.codeCaption}</p>
          </div>
        </div>
      </Section>

      <Section id="hosting" labelledBy="hosting-title">
        <SectionHeader eyebrow={hosting.eyebrow} id="hosting-title" title={hosting.title} />
        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <div className="panel flex flex-col gap-4 p-6 md:p-8">
            <h3 className="h3">{hosting.selfHost.title}</h3>
            <p className="text-muted-foreground leading-relaxed">{hosting.selfHost.body}</p>
            <div className="mt-auto flex flex-wrap gap-3 pt-2">
              <SelfHostCta size="default" />
              <CtaButton cta={hosting.selfHost.repositoryCta} variant="ghost" />
            </div>
          </div>
          <div className="panel flex flex-col gap-4 p-6 md:p-8">
            <h3 className="h3">{hosting.cloud.title}</h3>
            <p className="text-muted-foreground leading-relaxed">{hosting.cloud.body}</p>
            <div className="mt-auto flex flex-wrap gap-3 pt-2">
              <ButtonLink to={hosting.cloud.primaryCta.to}>{hosting.cloud.primaryCta.label}</ButtonLink>
              <CtaButton cta={hosting.cloud.moreCta} variant="ghost" />
            </div>
          </div>
        </div>
      </Section>

      <Section id="guarantees" labelledBy="guarantees-title" tone="sunken">
        <SectionHeader eyebrow={guarantees.eyebrow} id="guarantees-title" title={guarantees.title} />
        <div className="mt-12">
          <Guarantees headers={guarantees.headers} items={guarantees.items} />
        </div>
        {isReady(guarantees.cta.to) ? (
          <div className="mt-10 flex items-center gap-3">
            <ShieldCheckIcon aria-hidden="true" className="size-4 text-muted-foreground" />
            <ButtonLink to={guarantees.cta.to} variant="link">
              {guarantees.cta.label}
            </ButtonLink>
          </div>
        ) : null}
      </Section>

      <CtaBand eyebrow={closing.eyebrow} note={closing.note} />
    </>
  );
}

function Hero() {
  const { hero } = home;
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden">
      <div aria-hidden="true" className="ledger-bg pointer-events-none absolute inset-0" />
      <div className="container-site relative grid gap-12 pt-14 pb-16 md:pt-24 md:pb-20 lg:min-h-[max(40rem,calc(100svh-var(--header-h)))] lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-center lg:py-16">
        <div className="flex min-w-0 flex-col gap-6">
          <Eyebrow>{hero.eyebrow}</Eyebrow>
          <h1 className="h1" id="hero-title">
            {hero.title}
          </h1>
          <p className="lead max-w-xl">{hero.lead}</p>
          <div className="flex flex-wrap gap-3">
            <ButtonLink size="lg" to={hero.primaryCta.to}>
              {hero.primaryCta.label}
            </ButtonLink>
            <SelfHostCta />
          </div>
          <p className="text-muted-foreground text-sm">
            {hero.status}
            {hero.signIn ? (
              <>
                {' '}
                {hero.signIn.prompt}{' '}
                <a className="text-link" href={hero.signIn.href}>
                  {hero.signIn.label}
                </a>
                .
              </>
            ) : null}
            {hero.github ? (
              <>
                {' '}
                <a className="text-link" href={hero.github.href}>
                  {hero.github.label}
                </a>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <LogStack className="hidden sm:flex" />
          <LogStack className="sm:hidden" limit={3} />
          <div className="flex min-w-0 flex-col gap-2">
            <SiteCode code={hero.sample.code} language="bash" title={hero.sample.title} wrap />
            <p className="text-muted-foreground text-sm">
              <Rich text={hero.sample.caption} />
              {home.searchLatency ? (
                <>
                  {' '}
                  <Rich text={home.searchLatency} />
                </>
              ) : null}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
