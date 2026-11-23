import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRightIcon, CheckIcon } from 'lucide-react';
import { CtaBand } from '../components/marketing/cta-band';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { compareContent } from '../content/compare';
import { comparisons, TRADEMARK_LINE } from '../content/comparisons';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/compare/')({ head: () => pageHead('/compare'), component: CompareIndexPage });

// Words: content/compare.ts (`index`) and content/comparisons.ts. This file is layout only (content-modules.test.ts).

function CompareIndexPage() {
  const { hero, list, method } = compareContent.index;
  return (
    <>
      <PageHero eyebrow={hero.eyebrow} lead={hero.lead} title={hero.title} />

      <Section id="list" labelledBy="list-title">
        <SectionHeader eyebrow={list.eyebrow} id="list-title" title={list.title} />
        <ul className="mt-12 grid gap-4 md:grid-cols-2">
          {comparisons.map((comparison) => (
            <li className="panel panel-link relative flex flex-col gap-4 p-6 md:p-8" key={comparison.slug}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className="h3">{comparison.name}</h3>
                {comparison.note?.kind === 'category' ? (
                  <span className="rounded-full border px-2 py-0.5 font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
                    {list.categoryBadge}
                  </span>
                ) : null}
              </div>
              <p className="text-muted-foreground leading-relaxed">{comparison.card}</p>
              <p className="flex gap-3 text-sm leading-relaxed">
                <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand" />
                <span>
                  <span className="font-medium">{list.fitsWhen}</span>
                  <span className="text-muted-foreground">{comparison.fit}</span>
                </span>
              </p>
              <Link
                className="mt-auto inline-flex min-h-11 items-center gap-1.5 font-medium text-brand text-sm no-underline after:absolute after:inset-0 after:rounded-[inherit] hover:underline"
                to={comparison.path}
              >
                {list.cardLink(comparison.name)}
                <ArrowRightIcon aria-hidden="true" className="size-4" />
              </Link>
            </li>
          ))}
        </ul>
        <div className="panel panel-accent mt-4 flex flex-col gap-3 p-6 md:flex-row md:items-center md:gap-6 md:p-8">
          <p className="flex shrink-0 items-center gap-2 font-semibold">
            <span aria-hidden="true" className="size-2 rounded-full bg-brand" />
            {list.logbird.name}
          </p>
          <p className="text-muted-foreground leading-relaxed">
            <span className="font-medium text-foreground">{list.fitsWhen}</span>
            {list.logbird.fit}
          </p>
        </div>
      </Section>

      <Section id="method" labelledBy="method-title" tone="sunken">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start">
          <SectionHeader eyebrow={method.eyebrow} id="method-title" title={method.title} />
          <div className="flex flex-col gap-6">
            <ul className="flex flex-col gap-4">
              {method.rules.map((rule) => (
                <li className="flex gap-3 leading-relaxed" key={rule}>
                  <CheckIcon aria-hidden="true" className="mt-1 size-4 shrink-0 text-brand" />
                  {rule}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-sm">{TRADEMARK_LINE}</p>
          </div>
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
