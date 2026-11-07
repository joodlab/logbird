import { createFileRoute } from '@tanstack/react-router';
import { CheckIcon, GitBranchIcon, HeartHandshakeIcon, MailIcon } from 'lucide-react';
import { ButtonLink } from '../components/marketing/button-link';
import { CtaBand } from '../components/marketing/cta-band';
import { Rich } from '../components/marketing/rich';
import { Eyebrow, PageHero, Section, SectionHeader } from '../components/marketing/section';
import { StackedTable } from '../components/marketing/stacked-table';
import { GITHUB_PUBLIC, GITHUB_URL, SECURITY_EMAIL } from '../env';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/open-source')({ head: () => pageHead('/open-source'), component: OpenSourcePage });

// Copy: marketing/copy/open-source.md. Change wording there first.
const repo: { path: string; what: string }[] = [
  { path: 'apps/server', what: 'The API: ingest and read on `/v1`, the console API on `/api`, OpenAPI and a Scalar reference. Hono on Node.' },
  { path: 'apps/app', what: 'The console. TanStack Start and React.' },
  { path: 'apps/worker', what: 'The retention worker: hourly purges and housekeeping. BullMQ on Redis or Dragonfly.' },
  { path: 'apps/email', what: 'Previews for the sign-in and invitation email templates.' },
  { path: 'packages/contracts', what: "The API's request and response schemas. The source of truth for the API." },
  { path: 'packages/clickhouse', what: 'ClickHouse client, migrations, query builder and query-language parser.' },
  { path: 'packages/database', what: 'Postgres schema (Prisma): workspaces, projects, keys, saved views.' },
  { path: 'packages/auth', what: 'Email one-time-code sign-in and workspaces, on better-auth.' },
  { path: 'packages/sdk', what: '`@logbird/sdk`: the TypeScript client. No dependencies.' },
  { path: 'packages/integrations/*', what: '`@logbird/hono`, `@logbird/tanstack-start`, `@logbird/vue`, `@logbird/nuxt`.' },
  { path: 'packages/ui', what: "The console's design system." },
  { path: 'packages/seed', what: 'A generator of fictional hotel-booking data, sent through the public API.' },
  { path: 'examples/*', what: 'Small runnable examples for each integration.' },
];

const contributing = [
  'Node 22.18+ and pnpm',
  'Focused branches and Conventional Commits',
  'Pull requests that explain what changed, why, and how it was verified',
  'Screenshots for UI changes',
  'Fictional data only in tests',
  'Maintainers merge',
];

function SourceButton() {
  if (GITHUB_PUBLIC) {
    return (
      <ButtonLink href={GITHUB_URL} size="lg">
        <GitBranchIcon aria-hidden="true" className="size-4" />
        Source on GitHub
      </ButtonLink>
    );
  }
  // Disabled on purpose: no link until the repository is public.
  return (
    <span className="inline-flex h-(--control-size-large) cursor-not-allowed select-none items-center gap-1.5 rounded-md border border-dashed px-4 font-medium text-[15px] text-muted-foreground">
      <GitBranchIcon aria-hidden="true" className="size-4" />
      Source on GitHub — coming soon
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
        <span className="ms-2 font-mono text-[11px] text-muted-foreground">LICENSE</span>
      </div>
      <div className="flex flex-col gap-4 p-5 font-mono text-[13px] leading-relaxed md:p-6">
        <p className="font-semibold">MIT License</p>
        <p>Copyright (c) 2026 Joodlab</p>
        <p className="text-muted-foreground">Permission is hereby granted, free of charge, to any person obtaining a copy of this software…</p>
      </div>
      <figcaption className="border-t px-5 py-4 md:px-6">
        <ul className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          {['Read it', 'Run it', 'Change it', 'Ship it in your product'].map((item) => (
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
  return (
    <>
      <PageHero
        actions={
          <>
            <SourceButton />
            <ButtonLink size="lg" to="/self-hosting" variant="outline">
              Self-host it
            </ButtonLink>
            {GITHUB_PUBLIC ? null : (
              <p className="basis-full text-muted-foreground text-sm">The repository opens publicly soon. Until then, the code isn't public.</p>
            )}
          </>
        }
        aside={<LicenseCard />}
        eyebrow="Open source"
        lead="Logbird is released under the MIT licence. The API, the console, the retention worker, the SDK and the integrations are in one repository. You can read the code, run it, change it and ship it in your own product."
        title="MIT-licensed. All of it."
      />

      <Section id="repo" labelledBy="repo-title">
        <SectionHeader eyebrow="What's in the repository" id="repo-title" title="One repository, one codebase." />
        <StackedTable
          caption="What each folder of the Logbird repository contains"
          cardLabels={false}
          className="mt-10"
          columns={['What it is']}
          headerLabel={{ text: 'Path', visible: true }}
          headerWidth="w-[16rem]"
          rows={repo.map((entry) => ({
            key: entry.path,
            header: <code className="font-medium font-mono text-[0.875em]">{entry.path}</code>,
            cells: [<Rich key="what" text={entry.what} />],
          }))}
          stackBelow="sm"
        />
      </Section>

      <Section id="contributing" labelledBy="contributing-title" tone="sunken">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
          <SectionHeader
            eyebrow="Contributing"
            id="contributing-title"
            lead={
              <>
                {GITHUB_PUBLIC ? 'Contributions' : 'Once the repository is public, contributions'} follow <code>CONTRIBUTING.md</code>. In short: Node
                22.18+ and pnpm, focused branches, Conventional Commits, and pull requests that explain what changed, why, and how it was verified. UI
                changes include screenshots. Tests use fictional data only. Maintainers merge.
              </>
            }
            title="How to contribute."
          />
          <div className="flex flex-col gap-6">
            <ul className="panel grid gap-3 p-6 sm:grid-cols-2">
              {contributing.map((item) => (
                <li className="flex gap-3 text-sm leading-relaxed" key={item}>
                  <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand" />
                  {item}
                </li>
              ))}
            </ul>
            <ul className="body-copy flex flex-col gap-3 text-muted-foreground leading-relaxed">
              <li className="flex gap-3">
                <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-brand" />
                <span>
                  API changes start in <code>packages/contracts</code>. The server and console change in the same pull request.
                </span>
              </li>
              <li className="flex gap-3">
                <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-brand" />
                <span>There are no CI workflows yet. Checks and Docker builds run by hand before a release.</span>
              </li>
            </ul>
          </div>
        </div>
      </Section>

      <Section>
        <div className="grid gap-6 md:grid-cols-2">
          <section aria-labelledby="conduct-title" className="panel flex flex-col gap-4 p-6 md:p-8" id="conduct">
            <Eyebrow>Code of conduct</Eyebrow>
            <h2 className="flex items-center gap-3 font-semibold text-2xl tracking-tight" id="conduct-title">
              <HeartHandshakeIcon aria-hidden="true" className="size-5 shrink-0 text-brand" />
              Be kind and constructive.
            </h2>
            <p className="body-copy text-muted-foreground leading-relaxed">
              The project follows the Contributor Covenant, version 2.1. Report conduct issues through the private channel described in{' '}
              <code>SECURITY.md</code>.
            </p>
          </section>
          <section aria-labelledby="security-title" className="panel flex flex-col gap-4 p-6 md:p-8" id="security">
            <Eyebrow>Security reports</Eyebrow>
            <h2 className="flex items-center gap-3 font-semibold text-2xl tracking-tight" id="security-title">
              <MailIcon aria-hidden="true" className="size-5 shrink-0 text-brand" />
              Found a vulnerability? Tell us privately.
            </h2>
            <p className="text-muted-foreground leading-relaxed">
              Don't open a public issue. Email{' '}
              <a className="text-link" href={`mailto:${SECURITY_EMAIL}`}>
                {SECURITY_EMAIL}
              </a>
              . Include the affected version, a reproduction with fictional data, and the impact. We coordinate the fix and the disclosure with you
              privately. We don't offer a response-time SLA yet.
            </p>
            <div className="mt-auto pt-2">
              <ButtonLink to="/security" variant="outline">
                Security and data handling
              </ButtonLink>
            </div>
          </section>
        </div>
      </Section>

      <Section id="versions" labelledBy="versions-title" tone="sunken">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
          <div className="flex flex-col gap-6">
            <SectionHeader
              eyebrow="Versions"
              id="versions-title"
              lead="Version 0.1 is the first supported line. The SDK and the Hono integration are at 0.2. Nothing has been released yet: there are no npm packages or Docker images. Both come with the first release."
              title="Where the project is today."
            />
            <div>
              <ButtonLink to="/changelog" variant="outline">
                Read the changelog
              </ButtonLink>
            </div>
          </div>
          <dl className="panel grid grid-cols-2 overflow-hidden">
            {[
              { label: 'Supported line', value: '0.1' },
              { label: 'SDK and Hono integration', value: '0.2' },
              { label: 'npm packages', value: 'Not released' },
              { label: 'Docker images', value: 'Not released' },
            ].map((item) => (
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
