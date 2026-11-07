import { CheckIcon, ExternalLinkIcon, InfoIcon, LayersIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { type Comparison, type ComparisonSource, longDate, TRADEMARK_LINE } from '../../lib/comparisons';
import { ButtonLink } from './button-link';
import { Callout } from './callout';
import { CtaBand } from './cta-band';
import { Rich } from './rich';
import { PageHero, Section, SectionHeader } from './section';
import { SelfHostCta } from './self-host-cta';
import { StackedTable } from './stacked-table';

/** Footnote markers, e.g. [S6, S7], each linking to its entry in the page's Sources list. */
export function SourceRefs({ ids }: { ids: string[] }) {
  if (ids.length === 0) {
    return null;
  }
  return (
    <sup className="ms-0.5 whitespace-nowrap font-mono text-[0.72em] text-muted-foreground">
      [
      {ids.map((id, index) => (
        <Fragment key={id}>
          {index > 0 ? ', ' : null}
          <a aria-label={`Source ${id}`} className="text-link" href={`#source-${id}`}>
            {id}
          </a>
        </Fragment>
      ))}
      ]
    </sup>
  );
}

function ChooseList({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-4">
      {items.map((item) => (
        <li className="flex gap-3 leading-relaxed" key={item}>
          <CheckIcon aria-hidden="true" className="mt-1 size-4 shrink-0 text-brand" />
          <span className="body-copy text-muted-foreground">
            <Rich text={item} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function hostAndPath(url: string) {
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
}

function SourceItem({ source }: { source: ComparisonSource }) {
  return (
    <li className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 border-t py-4 first:border-t-0" id={`source-${source.id}`}>
      <span className="pt-0.5 font-mono text-muted-foreground text-sm">{source.id}</span>
      <div className="flex min-w-0 flex-col gap-1">
        <a className="text-link body-copy inline-flex min-h-6 items-start gap-1.5 leading-relaxed" href={source.url} rel="noopener" target="_blank">
          <span>
            <Rich text={source.title} />
            <span className="sr-only"> (opens in a new tab)</span>
          </span>
          <ExternalLinkIcon aria-hidden="true" className="mt-1.5 size-3.5 shrink-0" />
        </a>
        <p className="wrap-anywhere font-mono text-muted-foreground text-xs">{hostAndPath(source.url)}</p>
        {source.also?.map((url) => (
          <p className="wrap-anywhere font-mono text-xs" key={url}>
            <span className="text-muted-foreground">Also: </span>
            <a className="text-link" href={url} rel="noopener" target="_blank">
              {hostAndPath(url)}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        ))}
      </div>
    </li>
  );
}

/**
 * One layout for every /compare/* page: summary → table → when to choose them → when to choose Logbird → sources.
 * Facts live in lib/comparisons.ts; the page adds no claims of its own.
 */
export function ComparisonPage({ comparison, figure }: { comparison: Comparison; figure?: ReactNode }) {
  const { name, note, sources } = comparison;
  const accessed = new Set(sources.map((source) => source.accessed));
  const sharedDate = accessed.size === 1 ? longDate([...accessed][0] as string) : null;
  return (
    <>
      <PageHero
        aside={
          note ? (
            <Callout icon={note.kind === 'category' ? <LayersIcon className="size-5" /> : <InfoIcon className="size-5" />} title={note.title}>
              <Rich text={note.body} /> <SourceRefs ids={note.sourceIds} />
            </Callout>
          ) : undefined
        }
        eyebrow="Compare"
        lead={
          <>
            <Rich text={comparison.summary} /> <SourceRefs ids={comparison.summarySourceIds} />
          </>
        }
        title={comparison.title}
      />

      {figure ? (
        <section aria-label={`How Logbird and ${name} record history`} className="pt-16 md:pt-20">
          <div className="container-site">{figure}</div>
        </section>
      ) : null}

      <Section id="table" labelledBy="table-title">
        <SectionHeader
          eyebrow={sharedDate ? `Checked ${sharedDate}` : 'Checked against official sources'}
          id="table-title"
          lead="Each claim about another product links to its source below. Anything we couldn't verify is left out."
          title="At a glance"
        />
        <StackedTable
          caption={`Logbird and ${name} compared, with a source for each claim about ${name}`}
          className="mt-10"
          columns={['Logbird', name]}
          headerLabel={{ text: 'Topic' }}
          headerWidth="w-[22%]"
          highlightColumn={0}
          rows={comparison.rows.map((row) => ({
            key: row.label,
            header: row.label,
            cells: [
              <Rich key="logbird" text={row.logbird} />,
              <Fragment key="them">
                <Rich text={row.them} /> <SourceRefs ids={row.sourceIds} />
              </Fragment>,
            ],
          }))}
        />
      </Section>

      <Section id="choose" tone="sunken">
        <div className="grid gap-6 md:grid-cols-2">
          <section aria-labelledby="choose-them-title" className="panel flex flex-col gap-6 p-6 md:p-8">
            <h2 className="font-semibold text-xl tracking-tight" id="choose-them-title">
              When to choose {name}
            </h2>
            <ChooseList items={comparison.chooseThem} />
          </section>
          <section aria-labelledby="choose-logbird-title" className="panel flex flex-col gap-6 p-6 md:p-8">
            <h2 className="font-semibold text-xl tracking-tight" id="choose-logbird-title">
              When to choose Logbird
            </h2>
            <ChooseList items={comparison.chooseLogbird} />
            <div className="mt-auto flex flex-wrap gap-3 pt-2">
              <SelfHostCta size="default" />
              <ButtonLink to="/contact" variant="ghost">
                Join the waitlist
              </ButtonLink>
            </div>
          </section>
        </div>
      </Section>

      <Section id="sources" labelledBy="sources-title">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div className="flex flex-col gap-6">
            <SectionHeader
              id="sources-title"
              lead={sharedDate ? `All accessed ${sharedDate}. If something has changed, tell us and we'll fix it.` : undefined}
              title="Sources"
            />
            <div className="flex flex-wrap gap-3">
              <ButtonLink to="/contact" variant="outline">
                Report an outdated fact
              </ButtonLink>
              <ButtonLink to="/compare" variant="ghost">
                All comparisons
              </ButtonLink>
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-10">
            <ol aria-label={`Sources for the ${name} comparison`} className="panel px-5 md:px-6">
              {sources.map((source) => (
                <SourceItem key={source.id} source={source} />
              ))}
            </ol>
            <div className="flex flex-col gap-2">
              <h3 className="h3">What we couldn't verify</h3>
              <p className="body-copy text-muted-foreground leading-relaxed">
                Left out of the table: <Rich text={comparison.unverified} />
              </p>
            </div>
            <p className="text-muted-foreground text-sm">{TRADEMARK_LINE}</p>
          </div>
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
