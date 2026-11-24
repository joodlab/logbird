import { createFileRoute } from '@tanstack/react-router';
import { Fragment } from 'react';
import { ButtonLink } from '../components/marketing/button-link';
import { SiteCode } from '../components/marketing/code';
import { CtaBand } from '../components/marketing/cta-band';
import { FeatureRow, MiniFeature } from '../components/marketing/feature-row';
import { ClipFrame, ScreenshotFrame } from '../components/marketing/frame';
import { Rich } from '../components/marketing/rich';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { SelfHostCta } from '../components/marketing/self-host-cta';
import { product } from '../content/product';
import { roadmap } from '../content/roadmap';
import { shared } from '../content/shared';
import { pageHead } from '../lib/seo';

/** A console capture opens full size on tap, so a phone reader can zoom; the link is named after the frame label. */
const zoom = (label: string) => `${shared.openFullSize}: ${label}`;

export const Route = createFileRoute('/product')({ head: () => pageHead('/product'), component: ProductPage });

// Words and samples: content/product.ts. This file is layout only (content-modules.test.ts).
const sideSizes = '(min-width: 1024px) 640px, calc(100vw - 2rem)';
/** This page's bold lead-ins are a lighter weight than Rich's default. */
const strongClass = 'font-medium text-foreground';
const codeTitleClass = 'font-mono text-[0.85em] tracking-normal';

function ProductPage() {
  const { samples, hero, overview, toc, explorer, search, sql, entities, operations, eventDetail, more, setup, retention, readApi, webhooks } =
    product;
  return (
    <>
      <PageHero
        actions={
          <>
            <ButtonLink size="lg" to="/contact">
              {shared.accessCta}
            </ButtonLink>
            <SelfHostCta />
          </>
        }
        eyebrow={hero.eyebrow}
        lead={hero.lead}
        title={hero.title}
      />

      <section aria-label={overview.label} className="pt-12">
        <div className="container-site flex flex-col gap-8">
          <ScreenshotFrame caption={overview.caption} id="overview" label={overview.frameLabel} priority zoomLabel={zoom(overview.frameLabel)} />
          <nav aria-label={toc.label} className="flex flex-wrap gap-2">
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
        </div>
      </section>

      <FeatureRow
        bullets={[
          ...explorer.bullets,
          <>
            {explorer.keyboard.lead}
            {explorer.keyboard.keys.map(([key, text]) => (
              <Fragment key={key}>
                <kbd>{key}</kbd>
                {text}
              </Fragment>
            ))}
          </>,
          explorer.lastBullet,
        ]}
        eyebrow={explorer.eyebrow}
        id="explorer"
        title={explorer.title}
        visual={<ClipFrame caption={explorer.clipCaption} id="investigate" label={explorer.clipLabel} />}
      >
        {explorer.body}
      </FeatureRow>

      <FeatureRow
        bullets={[...search.bullets]}
        eyebrow={search.eyebrow}
        id="search"
        reverse
        title={search.title}
        visual={
          <div className="flex flex-col gap-4">
            <SiteCode code={samples.searchSample} language="text" title={search.codeTitle} />
            <ScreenshotFrame
              caption={search.caption}
              id="query-suggestions"
              label={search.frameLabel}
              zoomLabel={zoom(search.frameLabel)}
              sizes={sideSizes}
            />
          </div>
        }
      >
        <Rich text={search.body} />
      </FeatureRow>

      <Section compact id="sql-mode" labelledBy="sql-mode-title" tone="sunken">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)] lg:items-center lg:gap-14">
          <div className="flex flex-col gap-4">
            <p className="eyebrow">{sql.eyebrow}</p>
            <h2 className="font-semibold text-[clamp(1.5rem,2.6vw,2rem)] leading-tight tracking-[-0.025em]" id="sql-mode-title">
              {sql.title.before}
              <code className={codeTitleClass}>{sql.title.code}</code>
              {sql.title.after}
            </h2>
            <p className="body-copy text-muted-foreground leading-relaxed">
              <Rich text={sql.body} />
            </p>
          </div>
          <ScreenshotFrame caption={sql.caption} id="sql-rejected" label={sql.frameLabel} zoomLabel={zoom(sql.frameLabel)} sizes={sideSizes} />
        </div>
        <ol className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {sql.guards.map(([title, body], index) => (
            <li className="panel flex flex-col gap-2 p-5" key={title}>
              <span className="font-mono text-muted-foreground text-xs">{sql.guardLabel(index + 1)}</span>
              <h3 className="font-semibold">{title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">{body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-muted-foreground text-sm">{sql.note}</p>
      </Section>

      <FeatureRow
        bullets={entities.bullets.map((bullet) => <Rich key={bullet} strongClassName={strongClass} text={bullet} />)}
        eyebrow={entities.eyebrow}
        id="entities"
        title={entities.title}
        visual={
          <ScreenshotFrame
            caption={entities.caption}
            id="tenant"
            label={entities.frameLabel}
            zoomLabel={zoom(entities.frameLabel)}
            sizes={sideSizes}
          />
        }
      >
        {entities.body}
      </FeatureRow>

      <FeatureRow
        eyebrow={operations.eyebrow}
        id="operations"
        reverse
        title={operations.title}
        visual={
          <ScreenshotFrame
            caption={operations.caption}
            id="operation"
            label={operations.frameLabel}
            zoomLabel={zoom(operations.frameLabel)}
            sizes={sideSizes}
          />
        }
      >
        <Rich text={operations.body} />
      </FeatureRow>

      <FeatureRow
        bullets={[...eventDetail.bullets]}
        eyebrow={eventDetail.eyebrow}
        id="event-detail"
        title={eventDetail.title}
        visual={
          <ScreenshotFrame
            caption={eventDetail.caption}
            id="event-sheet"
            label={eventDetail.frameLabel}
            zoomLabel={zoom(eventDetail.frameLabel)}
            sizes={sideSizes}
          />
        }
      >
        {eventDetail.body}
      </FeatureRow>

      <Section compact labelledBy="more-title" tone="sunken">
        <SectionHeader id="more-title" title={more.title} />
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {more.items.map((item) => (
            <MiniFeature eyebrow={item.eyebrow} id={item.id} key={item.id} limit={'limit' in item ? item.limit : undefined} title={item.title}>
              {item.body}
            </MiniFeature>
          ))}
        </div>
      </Section>

      <FeatureRow
        bullets={[...setup.bullets]}
        eyebrow={setup.eyebrow}
        id="setup"
        title={setup.title}
        visual={<ScreenshotFrame caption={setup.caption} id="setup" label={setup.frameLabel} zoomLabel={zoom(setup.frameLabel)} sizes={sideSizes} />}
      >
        {setup.body}
      </FeatureRow>

      <FeatureRow
        eyebrow={retention.eyebrow}
        id="retention"
        limit={retention.limit}
        reverse
        title={retention.title}
        visual={
          <ScreenshotFrame
            caption={retention.caption}
            id="retention"
            label={retention.frameLabel}
            zoomLabel={zoom(retention.frameLabel)}
            sizes={sideSizes}
          />
        }
      >
        {retention.body}
      </FeatureRow>

      <FeatureRow
        eyebrow={readApi.eyebrow}
        id="read-api"
        limit={readApi.limit}
        title={readApi.title}
        visual={<SiteCode code={samples.readSample} language="ts" title={readApi.codeTitle} />}
      >
        <Rich text={readApi.body} />
        <span className="mt-4 block">
          <ButtonLink to="/developers" variant="link">
            {readApi.developersLink}
          </ButtonLink>
        </span>
      </FeatureRow>

      <FeatureRow
        bullets={webhooks.bullets.map((bullet) => <Rich key={bullet} text={bullet} />)}
        eyebrow={webhooks.eyebrow}
        id="webhooks"
        limit={webhooks.limit}
        reverse
        title={webhooks.title}
        visual={<SiteCode code={samples.webhookSample} language="text" title={webhooks.codeTitle} />}
      >
        <Rich text={webhooks.body} />
      </FeatureRow>

      <Section labelledBy="roadmap-title">
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

      <CtaBand />
    </>
  );
}
