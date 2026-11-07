import { createFileRoute } from '@tanstack/react-router';
import { Callout } from '../components/marketing/callout';
import { ScreenshotFrame } from '../components/marketing/frame';
import { Rich } from '../components/marketing/rich';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { buildLog, publicationDate as longDate, newestFirst, type Release, releases } from '../lib/publications';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/changelog')({ head: () => pageHead('/changelog'), component: ChangelogPage });

// Copy: marketing/copy/changelog.md. Entries come from publications.ts, added only once the owner approves them.
const releaseGroups: { key: keyof Omit<Release, 'version' | 'date'>; title: string }[] = [
  { key: 'upgrade', title: 'Upgrade notes' },
  { key: 'security', title: 'Security' },
  { key: 'added', title: 'Added' },
  { key: 'changed', title: 'Changed' },
  { key: 'fixed', title: 'Fixed' },
];

function Empty({ children }: { children: string }) {
  return <p className="panel mt-8 p-6 text-muted-foreground">{children}</p>;
}

function ChangelogPage() {
  return (
    <>
      <PageHero
        eyebrow="Changelog"
        lead={
          <Rich text="Two lists live here. **Releases** follow the repository's `CHANGELOG.md`: what changed in each version, and anything you must do to upgrade. The **build log** is a short post for each day of work, showing what we shipped with a real capture from the product." />
        }
        title="What changed, and when."
      />
      {releases.length ? null : (
        <div className="container-site pt-10">
          <Callout title="Nothing has been released yet.">Version 0.1 is in progress.</Callout>
        </div>
      )}

      <Section labelledBy="releases-title">
        <SectionHeader id="releases-title" title="Releases" />
        {releases.length ? (
          <ol className="mt-8 flex flex-col gap-6">
            {newestFirst(releases).map((release) => (
              <li className="panel flex flex-col gap-4 p-5 md:p-6" key={release.version}>
                <h3 className="font-semibold text-xl">
                  {release.version} <time className="ms-2 font-normal text-base text-muted-foreground">{longDate(release.date)}</time>
                </h3>
                {releaseGroups.map((group) =>
                  release[group.key]?.length ? (
                    <div className="flex flex-col gap-2" key={group.key}>
                      <h4 className="font-semibold text-sm uppercase tracking-wider">{group.title}</h4>
                      <ul className="flex list-disc flex-col gap-1 ps-5 text-muted-foreground">
                        {release[group.key]?.map((item) => (
                          <li key={item}>
                            <Rich text={item} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null,
                )}
              </li>
            ))}
          </ol>
        ) : (
          <Empty>No releases yet. The first one, 0.1.0, will list everything since the start of the project.</Empty>
        )}
      </Section>

      <Section labelledBy="build-log-title" tone="sunken">
        <SectionHeader id="build-log-title" lead="Day by day, in public." title="Build log" />
        {buildLog.length ? (
          <ol className="mt-10 flex flex-col gap-12">
            {newestFirst(buildLog).map((entry) => (
              <li className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start" key={`${entry.date}-${entry.title}`}>
                <article className="flex flex-col gap-2">
                  <time className="font-mono text-muted-foreground text-sm" dateTime={entry.date}>
                    {longDate(entry.date)}
                  </time>
                  <h3 className="h3">{entry.title}</h3>
                  <p className="body-copy text-muted-foreground leading-relaxed">
                    <Rich text={entry.summary} />
                  </p>
                </article>
                {entry.media ? <ScreenshotFrame id={entry.media} sizes="(min-width: 1024px) 600px, calc(100vw - 2rem)" /> : null}
              </li>
            ))}
          </ol>
        ) : (
          <Empty>No entries yet. Each day's post appears here once it's published.</Empty>
        )}
      </Section>
    </>
  );
}
