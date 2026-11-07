import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRightIcon, CheckIcon } from 'lucide-react';
import { CtaBand } from '../components/marketing/cta-band';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { ACCESSED, comparisons, longDate, TRADEMARK_LINE } from '../lib/comparisons';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/compare/')({ head: () => pageHead('/compare'), component: CompareIndexPage });

// Copy: marketing/copy/compare/README.md. Change wording there first.
const method = [
  'Official sources only: product docs, pricing pages, licence files and repositories.',
  'Every claim has a link and the date we checked it.',
  "Anything we couldn't verify is left out of the tables and listed as unverified.",
  'No logos. Product names are used only to identify the products, as their owners write them.',
  'We say where Logbird has gaps, too.',
];

function CompareIndexPage() {
  return (
    <>
      <PageHero
        eyebrow="Compare"
        lead={`There's more than one good way to keep an audit trail. These pages compare Logbird with other tools, using only facts we could check in their official docs, pricing pages and repositories. Each page says where the other tool is the better fit. We checked every fact on ${longDate(ACCESSED)} and list every source. If something has changed, tell us and we'll fix it.`}
        title="How Logbird compares."
      />

      <Section id="list" labelledBy="list-title">
        <SectionHeader eyebrow="Which tool fits" id="list-title" title="Each tool answers a different question." />
        <ul className="mt-12 grid gap-4 md:grid-cols-2">
          {comparisons.map((comparison) => (
            <li className="panel panel-link relative flex flex-col gap-4 p-6 md:p-8" key={comparison.slug}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className="h3">{comparison.name}</h3>
                {comparison.note?.kind === 'category' ? (
                  <span className="rounded-full border px-2 py-0.5 font-mono text-[11px] text-muted-foreground uppercase tracking-wider">
                    Different category
                  </span>
                ) : null}
              </div>
              <p className="text-muted-foreground leading-relaxed">{comparison.card}</p>
              <p className="flex gap-3 text-sm leading-relaxed">
                <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand" />
                <span>
                  <span className="font-medium">Fits when: </span>
                  <span className="text-muted-foreground">{comparison.fit}</span>
                </span>
              </p>
              <Link
                className="mt-auto inline-flex min-h-11 items-center gap-1.5 font-medium text-brand text-sm no-underline after:absolute after:inset-0 after:rounded-[inherit] hover:underline"
                to={comparison.path}
              >
                Logbird and {comparison.name} compared
                <ArrowRightIcon aria-hidden="true" className="size-4" />
              </Link>
            </li>
          ))}
        </ul>
        <div className="panel panel-accent mt-4 flex flex-col gap-3 p-6 md:flex-row md:items-center md:gap-6 md:p-8">
          <p className="flex shrink-0 items-center gap-2 font-semibold">
            <span aria-hidden="true" className="size-2 rounded-full bg-brand" />
            Logbird
          </p>
          <p className="text-muted-foreground leading-relaxed">
            <span className="font-medium text-foreground">Fits when: </span>
            your events must stay on your own servers, you want to send any event shape, and your team needs an operator console to answer "what
            happened?".
          </p>
        </div>
      </Section>

      <Section id="method" labelledBy="method-title" tone="sunken">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start">
          <SectionHeader eyebrow="How we compare" id="method-title" title="Our rules for these pages." />
          <div className="flex flex-col gap-6">
            <ul className="flex flex-col gap-4">
              {method.map((rule) => (
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
