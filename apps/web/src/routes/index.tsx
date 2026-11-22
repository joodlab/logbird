import { createFileRoute } from '@tanstack/react-router';
import { BoxesIcon, GitBranchIcon, SearchIcon, ShieldCheckIcon, TimerResetIcon, UserCogIcon } from 'lucide-react';
import { ButtonLink } from '../components/marketing/button-link';
import { SiteCode, SiteCodeTabs } from '../components/marketing/code';
import { CtaBand } from '../components/marketing/cta-band';
import { Envelope } from '../components/marketing/envelope';
import { ScreenshotFrame } from '../components/marketing/frame';
import { Guarantees } from '../components/marketing/guarantees';
import { LogStack } from '../components/marketing/log-stack';
import { Rich } from '../components/marketing/rich';
import { Eyebrow, Feature, Section, SectionHeader } from '../components/marketing/section';
import { SelfHostCta } from '../components/marketing/self-host-cta';
import { Architecture, Steps } from '../components/marketing/steps';
import { home } from '../content/home';
import { SITE } from '../content/site';
import { pageHead } from '../lib/seo';
import { isReady } from '../lib/site-map';

export const Route = createFileRoute('/')({ head: () => pageHead('/'), component: HomePage });

// Words: content/home.ts. This file is layout only (content-modules.test.ts).
function HomePage() {
  const { explorer, developers, operators, howItWorks, envelope, openSource, guarantees } = home;
  const { quickstart } = openSource;
  return (
    <>
      <Hero />

      <section aria-label={explorer.label} className="pb-8">
        <div className="container-site">
          <ScreenshotFrame caption={explorer.caption} id="explorer" label={explorer.frameLabel} />
        </div>
      </section>

      <Section id="developers" labelledBy="developers-title">
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
            {isReady(developers.cta.to) ? (
              <div>
                <ButtonLink to={developers.cta.to} variant="outline">
                  {developers.cta.label}
                </ButtonLink>
              </div>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <SiteCodeTabs tabs={developers.code.map((tab) => ({ ...tab, language: 'ts' as const }))} />
            <p className="text-muted-foreground text-sm">{developers.codeCaption}</p>
          </div>
        </div>
      </Section>

      <Section id="operators" labelledBy="operators-title" tone="sunken">
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
                [operators.features.impersonation, <UserCogIcon className="size-4" key="icon" />],
                [operators.features.retention, <TimerResetIcon className="size-4" key="icon" />],
              ] as const
            ).map(([feature, icon]) => (
              <Feature compact icon={icon} key={feature.title} title={feature.title}>
                <Rich text={feature.body} />
              </Feature>
            ))}
          </div>
        </div>
        {isReady(operators.cta.to) ? (
          <div className="mt-10">
            <ButtonLink to={operators.cta.to} variant="outline">
              {operators.cta.label}
            </ButtonLink>
          </div>
        ) : null}
      </Section>

      <Section id="how-it-works" labelledBy="how-title">
        <SectionHeader eyebrow={howItWorks.eyebrow} id="how-title" title={howItWorks.title} />
        <div className="mt-12 flex flex-col gap-14">
          <Steps items={howItWorks.steps.map((step) => ({ ...step, body: <Rich text={step.body} /> }))} />
          <Architecture {...howItWorks.architecture} />
        </div>
      </Section>

      <Section id="envelope" labelledBy="envelope-title" tone="sunken">
        <SectionHeader eyebrow={envelope.eyebrow} id="envelope-title" lead={envelope.lead} title={envelope.title} />
        <Envelope
          className="mt-12"
          frameTitle={envelope.frameTitle}
          lines={envelope.lines}
          notes={envelope.notes}
          requiredBadge={envelope.requiredBadge}
        />
        {isReady(envelope.cta.to) ? (
          <div className="mt-10">
            <ButtonLink to={envelope.cta.to} variant="outline">
              {envelope.cta.label}
            </ButtonLink>
          </div>
        ) : null}
      </Section>

      <Section id="open-source" labelledBy="oss-title">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div className="flex flex-col gap-6">
            <SectionHeader eyebrow={openSource.eyebrow} id="oss-title" lead={openSource.lead} title={openSource.title} />
            <ul className="flex flex-col gap-3 text-sm">
              {openSource.bullets.map((bullet) => (
                <li className="flex gap-3" key={bullet}>
                  <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
                  {bullet}
                </li>
              ))}
            </ul>
            {SITE.repoPublic || isReady(openSource.repositoryCta.to) ? (
              <div className="flex flex-wrap gap-3">
                {/* While the source is private the panel beside this carries the one self-host link. */}
                {SITE.repoPublic ? <SelfHostCta size="default" /> : null}
                <ButtonLink to={openSource.repositoryCta.to} variant="ghost">
                  {openSource.repositoryCta.label}
                </ButtonLink>
              </div>
            ) : null}
          </div>
          {quickstart.kind === 'public' ? (
            <div className="flex min-w-0 flex-col gap-3">
              <SiteCode code={quickstart.code} language="bash" title={quickstart.title} />
              <p className="text-muted-foreground text-sm">
                <Rich text={quickstart.next} />
              </p>
            </div>
          ) : (
            <div className="panel flex min-w-0 flex-col gap-4 p-6 md:p-8">
              <p className="eyebrow">{quickstart.eyebrow}</p>
              <p className="font-semibold text-lg">{quickstart.title}</p>
              <p className="text-muted-foreground text-sm leading-relaxed">
                <Rich text={quickstart.body} />
              </p>
              <div>
                <ButtonLink search={quickstart.cta.search} to={quickstart.cta.to} variant="outline">
                  {quickstart.cta.label}
                </ButtonLink>
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section id="guarantees" labelledBy="guarantees-title" tone="sunken">
        <SectionHeader eyebrow={guarantees.eyebrow} id="guarantees-title" title={guarantees.title} />
        <div className="mt-12">
          <Guarantees items={guarantees.items} />
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

      <CtaBand note={home.closingNote} />
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
          <h1 className="display" id="hero-title">
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
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <LogStack className="hidden sm:flex" />
          <LogStack className="sm:hidden" limit={3} />
          <div className="flex min-w-0 flex-col gap-2">
            <SiteCode code={hero.sample.code} language="bash" title={hero.sample.title} wrap />
            <p className="text-muted-foreground text-sm">
              <Rich text={hero.sample.caption} />
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
