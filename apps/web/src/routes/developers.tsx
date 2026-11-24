import { createFileRoute } from '@tanstack/react-router';
import { ButtonLink } from '../components/marketing/button-link';
import { SiteCode, SiteCodeTabs } from '../components/marketing/code';
import { CtaBand } from '../components/marketing/cta-band';
import { FeatureRow } from '../components/marketing/feature-row';
import { Rich } from '../components/marketing/rich';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { developers } from '../content/developers';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/developers')({ head: () => pageHead('/developers'), component: DevelopersPage });

// Words and samples: content/developers.ts. This file is layout only (content-modules.test.ts).
const { samples } = developers;
/** This page's bold lead-ins are a lighter weight than Rich's default. */
const strongClass = 'font-medium text-foreground';
const codeTitleClass = 'font-mono text-[0.8em] tracking-normal';

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul className="flex flex-col gap-3 text-sm leading-relaxed">
      {items.map((item) => (
        <li className="flex gap-3" key={item}>
          <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-brand" />
          <span className="text-muted-foreground">
            <Rich strongClassName={strongClass} text={item} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function OperationTree() {
  const nodeClass = 'panel flex flex-col gap-1 px-4 py-3';
  const { operation } = developers.envelope;
  return (
    <figure className="flex flex-col gap-3">
      <div className="rounded-2xl border border-dashed p-4 sm:p-5">
        <p className="mb-3 font-mono text-muted-foreground text-xs">{operation.title}</p>
        <div className={nodeClass}>
          <span className="font-mono text-sm">{operation.parent.action}</span>
          <span className="text-muted-foreground text-xs">{operation.parent.detail}</span>
        </div>
        <div className="ms-5 border-s ps-5 pt-3">
          <div className={`${nodeClass} border-brand/60`}>
            <span className="font-mono text-sm">{operation.child.action}</span>
            <span className="text-muted-foreground text-xs">{operation.child.detail}</span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        {operation.chips.map((chip) => (
          <span className="rounded-full border bg-background px-3 py-1 text-muted-foreground" key={chip}>
            {chip}
          </span>
        ))}
      </div>
      <figcaption className="text-muted-foreground text-sm">{operation.caption}</figcaption>
    </figure>
  );
}

function DevelopersPage() {
  const { hero, toc, quickstart, http, envelope, integrations, workers, delivery, limits, read, reference } = developers;
  return (
    <>
      <PageHero
        actions={
          <>
            <ButtonLink href="#quickstart" size="lg">
              {hero.quickstartAction}
            </ButtonLink>
            <ButtonLink size="lg" to="/self-hosting" variant="outline">
              {hero.selfHostAction}
            </ButtonLink>
          </>
        }
        aside={<SiteCode code={samples.smallest} language="bash" title={hero.smallestTitle} />}
        eyebrow={hero.eyebrow}
        lead={<Rich text={hero.lead} />}
        title={hero.title}
      />

      <nav aria-label={toc.label} className="container-site flex flex-wrap gap-2 pt-10">
        {toc.items.map(([id, label]) => (
          <a
            className="inline-flex min-h-9 items-center rounded-full border bg-background px-3.5 text-muted-foreground text-sm hover:text-foreground"
            href={`#${id}`}
            key={id}
          >
            {label}
          </a>
        ))}
      </nav>

      <FeatureRow
        bullets={quickstart.bullets.map((bullet) => <Rich key={bullet} text={bullet} />)}
        eyebrow={quickstart.eyebrow}
        id="quickstart"
        limit={<Rich strongClassName={strongClass} text={quickstart.limit} />}
        title={quickstart.title}
        visual={
          <div className="flex flex-col gap-3">
            <SiteCode code={samples.install} language="bash" title={quickstart.installTitle} />
            <SiteCode code={samples.quickstart} language="ts" title={quickstart.quickstartTitle} />
            <p className="text-muted-foreground text-sm">
              <Rich text={quickstart.npmNote} />
            </p>
          </div>
        }
      >
        {quickstart.body}
      </FeatureRow>

      <FeatureRow
        eyebrow={http.eyebrow}
        id="http"
        reverse
        title={http.title}
        visual={<SiteCode code={samples.http} language="bash" title={http.codeTitle} />}
      >
        <Rich text={http.body} />
      </FeatureRow>

      <Section compact id="envelope" labelledBy="envelope-title" tone="sunken">
        <SectionHeader eyebrow={envelope.eyebrow} id="envelope-title" lead={envelope.lead} title={envelope.title} />
        <div className="panel mt-10 overflow-hidden">
          <table className="table-site">
            <caption className="sr-only">{envelope.tableCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{envelope.columns.field}</th>
                <th scope="col">{envelope.columns.answers}</th>
                <th className="hidden md:table-cell" scope="col">
                  {envelope.columns.example}
                </th>
              </tr>
            </thead>
            <tbody>
              {envelope.rows.map(([field, answers, example]) => (
                <tr key={field}>
                  <th className="font-mono text-sm" scope="row">
                    {field}
                  </th>
                  <td>
                    {answers}
                    <code className="mt-1 block break-all font-mono text-muted-foreground text-xs md:hidden">{example}</code>
                  </td>
                  <td className="hidden font-mono text-muted-foreground text-xs md:table-cell">{example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-12 grid gap-10 lg:grid-cols-2">
          <div className="flex flex-col gap-6">
            <h3 className="h3">{envelope.rulesTitle}</h3>
            <Bullets items={envelope.rules} />
            <OperationTree />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <h3 className="h3">{envelope.workedTitle}</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">{envelope.workedBody}</p>
            <SiteCode code={samples.worked} language="json" title={envelope.workedCodeTitle} />
          </div>
        </div>
      </Section>

      <FeatureRow
        eyebrow={integrations.eyebrow}
        id="integrations"
        limit={integrations.limit}
        title={integrations.title}
        visual={
          <div className="flex flex-col gap-3">
            <SiteCode code={samples.honoInstall} language="bash" title={integrations.honoInstallTitle} />
            <SiteCodeTabs tabs={[{ id: 'hono', label: integrations.tabLabel, code: samples.hono, language: 'ts' }]} />
          </div>
        }
      >
        <p>
          <Rich text={integrations.body} />
        </p>
        <dl className="mt-5 grid gap-4 text-sm">
          {integrations.packages.map((entry) => (
            <div key={entry.name}>
              <dt className="font-medium text-foreground">
                <Rich text={entry.name} />
              </dt>
              <dd>
                <Rich text={entry.body} />
              </dd>
            </div>
          ))}
        </dl>
      </FeatureRow>

      <FeatureRow
        eyebrow={workers.eyebrow}
        id="workers"
        limit={workers.limit}
        reverse
        title={workers.title}
        visual={<SiteCode code={samples.workers} language="ts" title={workers.codeTitle} />}
      >
        <Rich text={workers.body} />
      </FeatureRow>

      <Section compact id="delivery" labelledBy="delivery-title" tone="sunken">
        <div className="grid gap-12 lg:grid-cols-2">
          <div className="flex flex-col gap-8">
            <SectionHeader
              eyebrow={delivery.eyebrow}
              id="delivery-title"
              title={
                <>
                  {delivery.title.before}
                  <code className={codeTitleClass}>{delivery.title.call}</code>
                  {delivery.title.middle}
                  <code className={codeTitleClass}>{delivery.title.status}</code>
                  {delivery.title.after}
                </>
              }
            />
            <Bullets items={delivery.bullets} />
          </div>
          <div className="flex flex-col gap-8" id="limits">
            <SectionHeader eyebrow={limits.eyebrow} id="limits-title" title={limits.title} />
            <div className="panel overflow-hidden">
              <table className="table-site">
                <caption className="sr-only">{limits.tableCaption}</caption>
                <tbody>
                  {limits.rows.map(([label, value]) => (
                    <tr key={label}>
                      <th scope="row">
                        <Rich text={label} />
                      </th>
                      <td className="text-muted-foreground">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Bullets items={limits.notes} />
          </div>
        </div>
      </Section>

      <FeatureRow
        eyebrow={read.eyebrow}
        id="read-api"
        limit={read.limit}
        title={read.title}
        visual={<SiteCode code={samples.read} language="ts" title={read.codeTitle} />}
      >
        <Rich text={read.body} />
      </FeatureRow>

      <Section compact id="reference" labelledBy="reference-title">
        <div className="panel flex flex-col gap-4 p-8 md:p-10">
          <p className="eyebrow">{reference.eyebrow}</p>
          <h2 className="h2" id="reference-title">
            {reference.title}
          </h2>
          <p className="lead max-w-3xl">
            <Rich text={reference.body} />
          </p>
          <div>
            <ButtonLink to="/self-hosting" variant="outline">
              {reference.action}
            </ButtonLink>
          </div>
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
