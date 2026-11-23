import { createFileRoute } from '@tanstack/react-router';
import {
  ArrowLeftRightIcon,
  ArrowRightIcon,
  BadgeXIcon,
  BanIcon,
  Building2Icon,
  GaugeIcon,
  GlobeIcon,
  HashIcon,
  KeyRoundIcon,
  MailIcon,
  ShieldAlertIcon,
  ShieldIcon,
} from 'lucide-react';
import { ButtonLink } from '../components/marketing/button-link';
import { Callout } from '../components/marketing/callout';
import { SiteCode } from '../components/marketing/code';
import { CtaBand } from '../components/marketing/cta-band';
import { Rich } from '../components/marketing/rich';
import { Feature, PageHero, Section, SectionHeader } from '../components/marketing/section';
import { SecurityContact } from '../components/marketing/security-contact';
import { Steps } from '../components/marketing/steps';
import { scopedReadLimits } from '../content/scoped-read-limits';
import { security } from '../content/security';
import { SITE } from '../content/site';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/security')({ head: () => pageHead('/security'), component: SecurityPage });

// Words: content/security.ts. This file is layout only (content-modules.test.ts).
/** The retention list's closing line is bold without the foreground colour. */
const undoClass = 'font-semibold';

function Bullets({ items, strongClassName }: { items: readonly string[]; strongClassName?: string }) {
  return (
    <ul className="body-copy flex flex-col gap-4 leading-relaxed">
      {items.map((item) => (
        <li className="flex gap-3" key={item}>
          <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-brand" />
          <span>
            <Rich strongClassName={strongClassName} text={item} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function OnThisPage() {
  const { contents } = security;
  return (
    <nav aria-label={contents.label} className="panel p-5 md:p-6">
      <p className="eyebrow mb-3">{contents.label}</p>
      <ol className="grid gap-x-6 sm:grid-cols-2">
        {contents.items.map((item) => (
          <li key={item.id}>
            <a
              className="flex min-h-11 items-center border-b text-muted-foreground text-sm no-underline transition-colors hover:text-foreground"
              href={`#${item.id}`}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function SelfHostDiagram() {
  const { diagram } = security.selfHost;
  return (
    <figure className="flex flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,14rem)] md:items-center lg:grid-cols-1">
        <div className="rounded-2xl border-2 border-brand/40 border-dashed p-4 md:p-5">
          <p className="mb-3 font-mono text-muted-foreground text-xs uppercase tracking-wider">{diagram.server}</p>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {diagram.parts.map((part) => (
              <li className="panel px-3 py-2.5 font-medium text-sm" key={part}>
                {part}
              </li>
            ))}
          </ul>
        </div>
        <div aria-hidden="true" className="flex items-center gap-2 self-center px-2 text-muted-foreground text-xs max-md:flex-col lg:flex-col">
          <span className="max-md:order-2 lg:order-2">{diagram.arrow}</span>
          <ArrowRightIcon className="size-4 max-md:rotate-90 lg:rotate-90" />
        </div>
        <div className="panel flex items-center gap-3 px-4 py-3">
          <MailIcon aria-hidden="true" className="size-4 shrink-0 text-brand" />
          <span className="font-medium text-sm">{diagram.smtp}</span>
        </div>
      </div>
      <figcaption className="text-muted-foreground text-sm">{diagram.caption}</figcaption>
    </figure>
  );
}

function SecurityPage() {
  const { samples, hero, selfHost, retention, isolation, sqlGuard, roles, impersonation, selfAudit, limits, reporting, dontClaim } = security;
  const { features, scoped } = isolation;
  return (
    <>
      <PageHero aside={<OnThisPage />} eyebrow={hero.eyebrow} lead={<Rich text={hero.lead} />} title={hero.title} />

      <Section id="self-host" labelledBy="self-host-title">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-center">
          <SectionHeader eyebrow={selfHost.eyebrow} id="self-host-title" lead={selfHost.lead} title={selfHost.title} />
          <SelfHostDiagram />
        </div>
      </Section>

      <Section id="retention" labelledBy="retention-title" tone="sunken">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start">
          <SectionHeader eyebrow={retention.eyebrow} id="retention-title" title={retention.title} />
          <Bullets items={retention.bullets} strongClassName={undoClass} />
        </div>
      </Section>

      <Section id="isolation" labelledBy="isolation-title">
        <SectionHeader eyebrow={isolation.eyebrow} id="isolation-title" title={isolation.title} />
        <div className="mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
          <Feature icon={<KeyRoundIcon className="size-4" />} title={features.bound.title}>
            {features.bound.body}
          </Feature>
          <Feature icon={<ArrowLeftRightIcon className="size-4" />} title={features.kinds.title}>
            <Rich text={features.kinds.body} />
          </Feature>
          <Feature icon={<HashIcon className="size-4" />} title={features.hashed.title}>
            {features.hashed.body}
          </Feature>
          <Feature icon={<BanIcon className="size-4" />} title={features.revocable.title}>
            {features.revocable.body}
          </Feature>
          <Feature icon={<Building2Icon className="size-4" />} title={features.boundaries.title}>
            {features.boundaries.body}
          </Feature>
        </div>
        {SITE.scopedReadLive ? (
          <section aria-labelledby="scoped-reads-title" className="mt-16 flex scroll-mt-24 flex-col gap-6" id="scoped-reads">
            <h3 className="font-semibold text-xl tracking-tight" id="scoped-reads-title">
              {scoped.title}
            </h3>
            <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
              <Feature icon={<Building2Icon className="size-4" />} title={scoped.scope}>
                <Rich text={scopedReadLimits.scope} />
              </Feature>
              <Feature icon={<ShieldIcon className="size-4" />} title={scoped.layers}>
                <Rich text={scopedReadLimits.layers} />
              </Feature>
              <Feature icon={<GlobeIcon className="size-4" />} title={scoped.origins}>
                <Rich text={scopedReadLimits.origins} />
              </Feature>
            </div>
          </section>
        ) : null}
      </Section>

      <Section id="sql-guard" labelledBy="sql-guard-title" tone="sunken">
        <SectionHeader eyebrow={sqlGuard.eyebrow} id="sql-guard-title" lead={<Rich text={sqlGuard.lead} />} title={sqlGuard.title} />
        <div className="mt-12 flex flex-col gap-10">
          <Steps
            items={sqlGuard.steps.map((step) => ({
              title: step.title,
              body: 'rich' in step ? <Rich text={step.rich} /> : step.body,
            }))}
          />
          <Callout icon={<ShieldAlertIcon className="size-5" />} title={sqlGuard.stop.title}>
            {sqlGuard.stop.body}
          </Callout>
        </div>
      </Section>

      <Section id="roles" labelledBy="roles-title">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-start">
          <SectionHeader eyebrow={roles.eyebrow} id="roles-title" lead={roles.lead} title={roles.title} />
          <div className="grid gap-6 lg:pt-10">
            <Feature compact icon={<MailIcon className="size-4" />} title={roles.codes.title}>
              {roles.codes.body}
            </Feature>
            <Feature compact icon={<GaugeIcon className="size-4" />} title={roles.limited.title}>
              {roles.limited.body}
            </Feature>
          </div>
        </div>
      </Section>

      <Section id="impersonation" labelledBy="impersonation-title" tone="sunken">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-center">
          <SectionHeader
            eyebrow={impersonation.eyebrow}
            id="impersonation-title"
            lead={<Rich text={impersonation.lead} />}
            title={impersonation.title}
          />
          <div className="flex min-w-0 flex-col gap-3">
            <SiteCode code={samples.impersonationSample} language="json" title={impersonation.codeTitle} />
            <p className="text-muted-foreground text-sm">{impersonation.note}</p>
          </div>
        </div>
      </Section>

      <Section id="self-audit" labelledBy="self-audit-title">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-center">
          <SectionHeader eyebrow={selfAudit.eyebrow} id="self-audit-title" lead={selfAudit.lead} title={selfAudit.title} />
          <figure className="flex flex-col gap-3">
            <ul className="flex flex-col gap-2">
              {selfAudit.actions.map((action, index) => (
                <li className="log-row" data-newest={index === 0} key={action}>
                  <span aria-hidden="true" className="log-dot bg-outcome-success" />
                  <span className="truncate">{action}</span>
                  <span className="text-muted-foreground text-xs">{selfAudit.scope}</span>
                </li>
              ))}
            </ul>
            <figcaption className="text-muted-foreground text-sm">{selfAudit.caption}</figcaption>
          </figure>
        </div>
      </Section>

      <Section id="limits" labelledBy="limits-title" tone="sunken">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start">
          <SectionHeader eyebrow={limits.eyebrow} id="limits-title" title={limits.title} />
          <Bullets items={limits.bullets} />
        </div>
      </Section>

      <Section id="reporting" labelledBy="reporting-title">
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="panel flex flex-col gap-5 p-6 md:p-8">
            <SectionHeader eyebrow={reporting.eyebrow} id="reporting-title" title={reporting.title} />
            <p className="text-muted-foreground leading-relaxed">
              {reporting.before}
              <SecurityContact />
              {reporting.after}
            </p>
            {reporting.email ? (
              <div className="mt-auto pt-2">
                <ButtonLink href={reporting.email.href} variant="outline">
                  <MailIcon aria-hidden="true" className="size-4" />
                  {reporting.email.label}
                </ButtonLink>
              </div>
            ) : null}
          </div>
          <section aria-labelledby="dont-claim-title" className="panel flex flex-col gap-5 p-6 md:p-8" id="dont-claim">
            <p className="eyebrow">{dontClaim.eyebrow}</p>
            <h2 className="h2 flex items-center gap-3" id="dont-claim-title">
              <BadgeXIcon aria-hidden="true" className="size-7 shrink-0 text-muted-foreground" />
              {dontClaim.title}
            </h2>
            <p className="text-muted-foreground leading-relaxed">{dontClaim.body}</p>
          </section>
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
