import { NO_RELEASES } from '../lib/releases';
import { SITE } from './site';

/**
 * Words of /changelog. Brief: marketing/copy/changelog.md. The releases come from GitHub and CHANGELOG.md
 * (src/lib/releases.ts) and the build log from src/lib/publications.ts. Inline marks: `code` and **bold**.
 */
export const changelog = {
  hero: {
    eyebrow: 'Changelog',
    title: 'What changed, and when.',
    lead: `Two lists live here. **Releases** are the versions published on GitHub, with the highlights from the repository's \`CHANGELOG.md\`${SITE.githubUrl ? '; each links to its full notes and upgrade steps' : ''}. The **build log** holds short updates on what we shipped, with a capture from the product when there is one.`,
  },
  releases: {
    title: 'Releases',
    /** Screen-reader prefix before each version number. */
    versionPrefix: 'Version ',
    latest: 'Latest',
    notesLink: (version: string) => `Full release notes, upgrade steps and images for ${version}`,
    empty: `${NO_RELEASES} The first release will list everything since the start of the project.`,
  },
  buildLog: {
    title: 'Build log',
    lead: 'Day by day, in public.',
    empty: "No entries yet. Each day's post appears here once it's published.",
  },
} as const;
