import { createFileRoute } from '@tanstack/react-router';
import { CheckIcon, GitBranchIcon, HeartHandshakeIcon, MailIcon } from 'lucide-react';
import { ButtonLink } from '../components/marketing/button-link';
import { CtaBand } from '../components/marketing/cta-band';
import { Rich } from '../components/marketing/rich';
import { Eyebrow, PageHero, Section, SectionHeader } from '../components/marketing/section';
import { SecurityContact } from '../components/marketing/security-contact';
import { SelfHostCta } from '../components/marketing/self-host-cta';
import { StackedTable } from '../components/marketing/stacked-table';
import { openSource } from '../content/open-source';
import { GITHUB_PUBLIC, GITHUB_URL } from '../env';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/open-source')({ head: () => pageHead('/open-source'), component: OpenSourcePage });

// Words: content/open-source.ts. This file is layout only (content-modules.test.ts).
const { source, license } = openSource;

function SourceButton() {
  if (GITHUB_PUBLIC && GITHUB_URL) {
    return (
      <ButtonLink href={GITHUB_URL} size="lg">
        <GitBranchIcon aria-hidden="true" className="size-4" />
        {source.public}
      </ButtonLink>
    );
  }
  // Disabled on purpose: no link until the repository is public.
  return (
    <span className="inline-flex h-(--control-size-large) cursor-not-allowed select-none items-center gap-1.5 rounded-md border border-dashed px-4 font-medium text-[15px] text-muted-foreground">
      <GitBranchIcon aria-hidden="true" className="size-4" />
      {source.private}
    </span>
  );
}

function LicenseCard() {
  return (
    <figure className="frame">
      <div aria-hidden="true" className="frame-bar">
        <i />
        <i />
        <i />
        <span className="ms-2 font-mono text-[11px] text-muted-foreground">{license.barTitle}</span>
      </div>
      <div className="flex flex-col gap-4 p-5 font-mono text-[13px] leading-relaxed md:p-6">
        <p className="font-semibold">{license.name}</p>
        {license.copyright ? <p>{license.copyright}</p> : null}
        <p className="text-muted-foreground">{license.excerpt}</p>
      </div>
      <figcaption className="border-t px-5 py-4 md:px-6">
        <ul className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {license.freedoms.map((item) => (
            <li className="flex items-center gap-2" key={item}>
              <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-outcome-success" />
              {item}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

function OpenSourcePage() {
  const { hero, repo, contributing, conduct, security, versions } = openSource;
  return (
    <>
      <PageHero
        actions={
          <>
            <SourceButton />
            <SelfHostCta />
            {hero.privateNote ? <p className="basis-full text-muted-foreground text-sm">{hero.privateNote}</p> : null}
          </>
        }
        aside={<LicenseCard />}
        eyebrow={hero.eyebrow}
        lead={hero.lead}
        title={hero.title}
      />

      <Section id="repo" labelledBy="repo-title">
        <SectionHeader eyebrow={repo.eyebrow} id="repo-title" title={repo.title} />
        <StackedTable
          caption={repo.caption}
          cardLabels={false}
          className="mt-10"
          columns={[repo.column]}
          headerLabel={{ text: repo.header, visible: true }}
          headerWidth="w-[16rem]"
          rows={repo.rows.map((entry) => ({
            key: entry.path,
            header: <code className="font-medium font-mono text-[0.875em]">{entry.path}</code>,
            cells: [<Rich key="what" text={entry.what} />],
          }))}
          stackBelow="sm"
        />
      </Section>

      <Section id="contributing" labelledBy="contributing-title" tone="sunken">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <SectionHeader eyebrow={contributing.eyebrow} id="contributing-title" lead={<Rich text={contributing.lead} />} title={contributing.title} />
          <div className="flex flex-col gap-6">
            <ul className="panel grid gap-3 p-6 sm:grid-cols-2">
              {contributing.checklist.map((item) => (
                <li className="flex gap-3 text-sm leading-relaxed" key={item}>
                  <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand" />
                  {item}
                </li>
              ))}
            </ul>
            <ul className="body-copy flex flex-col gap-3 text-muted-foreground leading-relaxed">
              {contributing.notes.map((note) => (
                <li className="flex gap-3" key={note}>
                  <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-brand" />
                  <span>
                    <Rich text={note} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section>
        <div className="grid gap-6 md:grid-cols-2">
          <section aria-labelledby="conduct-title" className="panel flex flex-col gap-4 p-6 md:p-8" id="conduct">
            <Eyebrow>{conduct.eyebrow}</Eyebrow>
            <h2 className="flex items-center gap-3 font-semibold text-2xl tracking-tight" id="conduct-title">
              <HeartHandshakeIcon aria-hidden="true" className="size-5 shrink-0 text-brand" />
              {conduct.title}
            </h2>
            <p className="body-copy text-muted-foreground leading-relaxed">
              <Rich text={conduct.body} />
            </p>
          </section>
          <section aria-labelledby="security-title" className="panel flex flex-col gap-4 p-6 md:p-8" id="security">
            <Eyebrow>{security.eyebrow}</Eyebrow>
            <h2 className="flex items-center gap-3 font-semibold text-2xl tracking-tight" id="security-title">
              <MailIcon aria-hidden="true" className="size-5 shrink-0 text-brand" />
              {security.title}
            </h2>
            <p className="text-muted-foreground leading-relaxed">
              {security.before}
              <SecurityContact />
              {security.after}
            </p>
            <div className="mt-auto pt-2">
              <ButtonLink to="/security" variant="outline">
                {security.action}
              </ButtonLink>
            </div>
          </section>
        </div>
      </Section>

      <Section id="versions" labelledBy="versions-title" tone="sunken">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
          <div className="flex flex-col gap-6">
            <SectionHeader eyebrow={versions.eyebrow} id="versions-title" lead={<Rich text={versions.lead} />} title={versions.title} />
            <div>
              <ButtonLink to="/changelog" variant="outline">
                {versions.action}
              </ButtonLink>
            </div>
          </div>
          <dl className="panel grid grid-cols-2 overflow-hidden">
            {versions.facts.map((item) => (
              <div className="flex flex-col gap-1 border-b p-5 odd:border-e [&:nth-last-child(-n+2)]:border-b-0" key={item.label}>
                <dt className="text-muted-foreground text-sm">{item.label}</dt>
                <dd className="font-mono font-semibold text-lg">{item.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
