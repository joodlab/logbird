import { snapshotReleases } from './releases.snapshot';

/**
 * Published Logbird releases for /changelog and the self-host quickstart. A version is listed only once its GitHub
 * Release exists (the tag workflow creates it after the images publish). Its highlights come from the matching
 * `## X.Y.Z` → `### Highlights` section of the repository's CHANGELOG.md, the same bullets that open the release notes.
 *
 * The build resolves the list once (scripts/releases.ts, injected by vite.config.ts as `__RELEASES__`): the GitHub
 * Releases API, falling back to the committed snapshot (releases.snapshot.ts) when GitHub can't be reached, so a
 * deploy never fails or empties the page because of an API outage. Tests and Node scripts read the snapshot.
 */
export interface Release {
  /** SemVer without the `v`, e.g. `0.1.0`. */
  version: string;
  /** ISO date the GitHub Release was published, e.g. `2026-11-09`. */
  date: string;
  /** One to three bullets from CHANGELOG.md; inline `code`, **bold** and *emphasis* render (Rich). */
  highlights: string[];
}

declare const __RELEASES__: Release[] | undefined;

export const releases: Release[] = typeof __RELEASES__ === 'undefined' ? snapshotReleases : __RELEASES__;

const semver = (version: string) => version.split('.').map(Number);
/** Newest version first, by SemVer rather than date. */
export const byVersionDesc = (a: Pick<Release, 'version'>, b: Pick<Release, 'version'>) => {
  const [x, y] = [semver(a.version), semver(b.version)];
  for (let index = 0; index < 3; index++) {
    const diff = (y[index] ?? 0) - (x[index] ?? 0);
    if (diff) {
      return diff;
    }
  }
  return 0;
};

/** The GitHub Release page, from the configured repository URL (WEB_GITHUB_URL). */
export const releaseUrl = (githubUrl: string, release: Pick<Release, 'version'>) => `${githubUrl}/releases/tag/v${release.version}`;

/** The newest published release, which the self-host quickstart pins. */
export const latestRelease: Release | undefined = [...releases].sort(byVersionDesc)[0];
