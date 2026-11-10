import { createFileRoute } from '@tanstack/react-router';
import { ScreenshotFrame } from '../components/marketing/frame';
import { Rich } from '../components/marketing/rich';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { GITHUB_PUBLIC, GITHUB_URL } from '../env';
import { buildLog, publicationDate as longDate, newestFirst } from '../lib/publications';
import { byVersionDesc, type Release, releases, releaseUrl } from '../lib/releases';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/changelog')({ head: () => pageHead('/changelog'), component: ChangelogPage });

// Copy: marketing/copy/changelog.md. Releases come from GitHub and CHANGELOG.md (src/lib/releases.ts); the build log from
// publications.ts.
const releaseNotesHref = (release: Release) => (GITHUB_PUBLIC && GITHUB_URL ? releaseUrl(GITHUB_URL, release) : undefined);

function Empty({ children }: { children: string }) {
  return <p className="panel mt-8 p-6 text-muted-foreground">{children}</p>;
}

function ChangelogPage() {
  return (
    <>
      <PageHero
        eyebrow="Changelog"
        lead={
          <Rich text="Two lists live here. **Releases** are the versions published on GitHub, with the highlights from the repository's `CHANGELOG.md`; each links to its full notes and upgrade steps. The **build log** is a short post for each day of work, showing what we shipped with a real capture from the product." />
        }
        title="What changed, and when."
      />

      <Section labelledBy="releases-title">
        <SectionHeader id="releases-title" title="Releases" />
        {releases.length ? (
          <ol className="mt-8 flex flex-col gap-6">
            {[...releases].sort(byVersionDesc).map((release, index) => {
              const href = releaseNotesHref(release);
              return (
                <li className="panel flex flex-col gap-4 p-5 md:p-6" key={release.version}>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h3 className="font-semibold text-xl">
                      <span className="sr-only">Version </span>
                      {release.version}
                    </h3>
                    <time className="text-base text-muted-foreground" dateTime={release.date}>
                      {longDate(release.date)}
                    </time>
                    {index === 0 ? <span className="rounded-full border px-2 py-0.5 font-mono text-muted-foreground text-xs">Latest</span> : null}
                  </div>
                  {release.highlights.length ? (
                    <ul className="flex list-disc flex-col gap-1 ps-5 text-muted-foreground">
                      {release.highlights.map((item) => (
                        <li key={item}>
                          <Rich text={item} />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {href ? (
                    <p className="text-sm">
                      <a className="text-link" href={href}>
                        Full release notes, upgrade steps and images for {release.version}
                      </a>
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <Empty>Nothing has been released yet. The first release will list everything since the start of the project.</Empty>
        )}
      </Section>

      <Section labelledBy="build-log-title" tone="sunken">
        <SectionHeader id="build-log-title" lead="Day by day, in public." title="Build log" />
        {buildLog.length ? (
          <ol className="mt-10 flex flex-col gap-12">
            {newestFirst(buildLog).map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: entries are sorted once at build time; two may share a date and title
              <li className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start" key={index}>
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
