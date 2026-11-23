import { createFileRoute } from '@tanstack/react-router';
import { ButtonLink } from '../components/marketing/button-link';
import { SiteCode } from '../components/marketing/code';
import { CtaBand } from '../components/marketing/cta-band';
import { FeatureRow } from '../components/marketing/feature-row';
import { Rich } from '../components/marketing/rich';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { SelfHostCta } from '../components/marketing/self-host-cta';
import { Architecture, Steps } from '../components/marketing/steps';
import { architecture } from '../content/architecture';
import { selfHosting } from '../content/self-hosting';
import { SITE } from '../content/site';
import { selfHostQuickstart } from '../lib/selfhost';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/self-hosting')({ head: () => pageHead('/self-hosting'), component: SelfHostingPage });

// Words and samples: content/self-hosting.ts. This file is layout only (content-modules.test.ts).
const bundledServices = ['console', 'api', 'worker', 'postgres', 'clickhouse', 'redis'];

/** One container stack as a small diagram: the shaded boxes run inside Compose, dashed ones are yours. */
function Stack({ title, file, inside, outside, proxy }: { title: string; file: string; inside: string[]; outside?: string[]; proxy?: string }) {
  return (
    <figure className="flex flex-col gap-3">
      {proxy ? <div className="rounded-lg border border-dashed px-3 py-2 text-center text-muted-foreground text-xs">{proxy}</div> : null}
      <div className="rounded-xl border bg-[var(--surface-sunken)] p-3">
        <p className="mb-2 font-mono text-[11px] text-muted-foreground">{file}</p>
        <div className="grid grid-cols-2 gap-2">
          {inside.map((service) => (
            <span
              className="rounded-md border bg-[var(--surface)] px-2.5 py-1.5 text-center font-mono text-xs data-[accent=true]:border-brand/60"
              data-accent={service === 'console'}
              key={service}
            >
              {service}
            </span>
          ))}
        </div>
      </div>
      {outside ? (
        <div className="grid grid-cols-3 gap-2">
          {outside.map((service) => (
            <span className="rounded-md border border-dashed px-2 py-1.5 text-center font-mono text-[11px] text-muted-foreground" key={service}>
              {service}
            </span>
          ))}
        </div>
      ) : null}
      <figcaption className="sr-only">{title}</figcaption>
    </figure>
  );
}

function SelfHostingPage() {
  const { samples, hero, quickstart, requirements, options, tls, ops, notYet, cta } = selfHosting;
  const { guide } = quickstart.notes;
  return (
    <>
      <PageHero
        actions={
          <>
            {SITE.repoPublic ? (
              <ButtonLink href="#quickstart" size="lg">
                {hero.quickstartAction}
              </ButtonLink>
            ) : (
              <ButtonLink search={{ interest: 'self-host' }} size="lg" to="/contact">
                {hero.notifyAction}
              </ButtonLink>
            )}
            <ButtonLink size="lg" to="/contact" variant="outline">
              {hero.cloudAction}
            </ButtonLink>
          </>
        }
        aside={
          <div className="flex flex-col gap-3">
            <Stack file="docker-compose.yml" inside={bundledServices} title={hero.stackTitle} />
            <p className="text-muted-foreground text-sm">{hero.status}</p>
          </div>
        }
        eyebrow={hero.eyebrow}
        lead={hero.lead}
        title={hero.title}
      />

      {SITE.repoPublic && SITE.selfHostVersion ? (
        <Section id="quickstart" labelledBy="quickstart-title">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div className="flex flex-col gap-8">
              <SectionHeader eyebrow={quickstart.eyebrow} id="quickstart-title" lead={quickstart.lead} title={quickstart.title} />
              <ol className="flex flex-col gap-4 text-sm leading-relaxed">
                {quickstart.steps.map((step, index) => (
                  <li className="flex gap-4" key={step}>
                    <span
                      aria-hidden="true"
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border bg-background font-mono text-xs"
                    >
                      {index + 1}
                    </span>
                    <span className="pt-1 text-muted-foreground">
                      <Rich text={step} />
                    </span>
                  </li>
                ))}
              </ol>
              <ul className="flex flex-col gap-2 border-t pt-6 text-muted-foreground text-sm leading-relaxed">
                <li>{quickstart.notes.init}</li>
                <li>
                  {guide.before}
                  <a className="text-link" href={guide.href}>
                    {guide.label}
                  </a>
                  {guide.after}
                </li>
                <li>
                  <Rich text={quickstart.notes.health} />
                </li>
              </ul>
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <SiteCode code={selfHostQuickstart} language="bash" title={quickstart.serverTitle} />
              <SiteCode code={samples.firstEvent} language="bash" title={quickstart.eventTitle} />
            </div>
          </div>
        </Section>
      ) : (
        <Section id="quickstart" labelledBy="quickstart-title">
          <div className="panel flex flex-col gap-4 p-8 md:p-10">
            <p className="eyebrow">{quickstart.eyebrow}</p>
            <h2 className="h2" id="quickstart-title">
              {quickstart.pending.title}
            </h2>
            <p className="lead max-w-3xl">{quickstart.pending.lead}</p>
            <div>
              {SITE.repoPublic ? (
                <a className="text-link" href={quickstart.pending.buildLink.href}>
                  {quickstart.pending.buildLink.label}
                </a>
              ) : (
                <SelfHostCta size="default" variant="outline" />
              )}
            </div>
          </div>
        </Section>
      )}

      <Section compact id="requirements" labelledBy="requirements-title" tone="sunken">
        <SectionHeader eyebrow={requirements.eyebrow} id="requirements-title" title={requirements.title} />
        <dl className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {requirements.items.map(([term, detail]) => (
            <div className="panel flex flex-col gap-2 p-5" key={term}>
              <dt className="font-semibold">{term}</dt>
              <dd className="text-muted-foreground text-sm leading-relaxed">{detail}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-12">
          <Architecture {...architecture} />
        </div>
      </Section>

      <Section compact id="options" labelledBy="options-title">
        <SectionHeader eyebrow={options.eyebrow} id="options-title" title={options.title} />
        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          {[
            {
              ...options.bundled,
              stack: <Stack file="docker-compose.yml" inside={bundledServices} title={options.bundled.stackTitle} />,
            },
            {
              ...options.coolify,
              stack: (
                <Stack file="docker-compose.coolify.yml" inside={bundledServices} proxy={options.coolify.proxy} title={options.coolify.stackTitle} />
              ),
            },
            {
              ...options.external,
              stack: (
                <Stack
                  file="docker-compose.external.yml"
                  inside={['console', 'api', 'worker', 'migrate']}
                  outside={['postgres', 'clickhouse', 'redis']}
                  title={options.external.stackTitle}
                />
              ),
            },
          ].map((option) => (
            <section aria-label={option.title} className="panel flex flex-col gap-5 p-6" key={option.title}>
              {option.stack}
              <h3 className="h3">{option.title}</h3>
              <p className="body-copy text-muted-foreground text-sm leading-relaxed">
                <Rich text={option.body} />
              </p>
            </section>
          ))}
        </div>
        <p className="mt-6 border-s-2 ps-3 text-muted-foreground text-sm">
          {options.guide ? (
            <>
              {options.guide.before}
              <a className="text-link" href={options.guide.href}>
                {options.guide.label}
              </a>
              {options.guide.after}
            </>
          ) : null}
          {options.note}
        </p>
      </Section>

      <FeatureRow
        eyebrow={tls.eyebrow}
        id="tls"
        limit={tls.limit}
        title={tls.title}
        visual={<SiteCode code={samples.tls} language="bash" title={tls.codeTitle} />}
      >
        <Rich text={tls.body} />
      </FeatureRow>

      <Section compact labelledBy="ops-title" tone="sunken">
        <h2 className="sr-only" id="ops-title">
          {ops.title}
        </h2>
        <div className="grid gap-12 lg:grid-cols-2">
          <section aria-labelledby="smtp-title" className="flex flex-col gap-4" id="smtp">
            <p className="eyebrow">{ops.smtp.eyebrow}</p>
            <h3 className="h2" id="smtp-title">
              {ops.smtp.title}
            </h3>
            <p className="body-copy text-muted-foreground leading-relaxed">{ops.smtp.body}</p>
          </section>
          <section aria-labelledby="upgrades-title" className="flex flex-col gap-6" id="upgrades">
            <p className="eyebrow">{ops.upgrades.eyebrow}</p>
            <h3 className="h2" id="upgrades-title">
              {ops.upgrades.title}
            </h3>
            <Steps items={[...ops.upgrades.steps]} vertical />
            <ul className="flex flex-col gap-2 border-t pt-5 text-muted-foreground text-sm leading-relaxed">
              {ops.upgrades.notes.map((note) => (
                <li key={note}>
                  <Rich text={note} />
                </li>
              ))}
            </ul>
          </section>
        </div>
      </Section>

      <Section compact id="not-yet" labelledBy="not-yet-title">
        <SectionHeader eyebrow={notYet.eyebrow} id="not-yet-title" title={notYet.title} />
        <dl className="mt-10 grid gap-x-10 gap-y-2 md:grid-cols-2">
          {notYet.items.map(([term, detail]) => (
            <div className="flex flex-col gap-1 border-b py-4" key={term}>
              <dt className="font-medium">{term}</dt>
              <dd className="text-muted-foreground text-sm leading-relaxed">{detail}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <CtaBand body={cta.body} title={cta.title} />
    </>
  );
}
