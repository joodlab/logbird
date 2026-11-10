import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteConfigFrom } from '../src/env';
import type { Release } from '../src/lib/releases';
import { snapshotReleases } from '../src/lib/releases.snapshot';
import { loadPublicEnv } from './public-env';

/**
 * Resolves the release list once per build (see src/lib/releases.ts). `pnpm --filter @logbird/web releases:sync`
 * refreshes the committed snapshot from the same source.
 */

const webDir = fileURLToPath(new URL('..', import.meta.url));
export const CHANGELOG_PATH = resolve(webDir, '../../CHANGELOG.md');
const SNAPSHOT_PATH = resolve(webDir, 'src/lib/releases.snapshot.ts');
const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/;

/** `owner/name` of a github.com repository URL, or undefined for anything else. */
export function githubRepo(url: string | undefined): string | undefined {
  if (!url) {
    return;
  }
  const { hostname, pathname } = new URL(url);
  const match = pathname.match(/^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return hostname === 'github.com' && match ? `${match[1]}/${match[2]}` : undefined;
}

/** The bullets under `### Highlights` in CHANGELOG.md's `## <version>` section (empty when there are none). */
export function changelogHighlights(markdown: string, version: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start < 0) {
    return [];
  }
  const highlights: string[] = [];
  let inHighlights = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) {
      break;
    }
    if (line.startsWith('### ')) {
      inHighlights = line.trim() === '### Highlights';
      continue;
    }
    const bullet = line.match(/^- (\S.*)$/);
    if (inHighlights && bullet?.[1]) {
      highlights.push(bullet[1].trim());
    }
  }
  return highlights.slice(0, 3);
}

interface GitHubRelease {
  tag_name: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
}

/** Published, stable `vX.Y.Z` releases from the GitHub API, without highlights. */
export async function fetchGitHubReleases(
  repo: string,
  { token, fetchImpl = fetch }: { token?: string; fetchImpl?: typeof fetch } = {},
): Promise<Omit<Release, 'highlights'>[]> {
  // Follow GitHub's `Link: rel="next"` pagination (at most 20 pages of 100), so no release silently drops off.
  const body: GitHubRelease[] = [];
  let next: string | undefined = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  for (let page = 0; next && page < 20; page++) {
    const response: Response = await fetchImpl(next, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'logbird-web-build',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub answered ${response.status}`);
    }
    body.push(...((await response.json()) as GitHubRelease[]));
    next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  }
  if (next) {
    throw new Error('GitHub has more than 2,000 releases; raise the page limit.');
  }
  return body.flatMap((release) => {
    const version = release.tag_name.match(STABLE_TAG)?.[1];
    if (!version || release.draft || release.prerelease || !release.published_at) {
      return [];
    }
    return [{ version, date: release.published_at.slice(0, 10) }];
  });
}

/**
 * The build's release list: with a public GitHub repository the live list, otherwise (or on any failure) the snapshot,
 * each with its CHANGELOG.md highlights. Pages link to a release only when the repository is public.
 */
export async function loadReleases({
  githubUrl,
  githubPublic,
  changelog = readFileSync(CHANGELOG_PATH, 'utf8'),
  token = process.env.GITHUB_TOKEN,
  fetchImpl,
  log = console.warn,
}: {
  githubUrl?: string;
  githubPublic: boolean;
  changelog?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}): Promise<Release[]> {
  const repo = githubPublic ? githubRepo(githubUrl) : undefined;
  let published: Omit<Release, 'highlights'>[] = snapshotReleases;
  if (repo) {
    try {
      published = await fetchGitHubReleases(repo, { token, fetchImpl });
    } catch (error) {
      log(`releases: using the committed snapshot (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return published.map(({ version, date }) => ({ version, date, highlights: changelogHighlights(changelog, version) }));
}

async function sync() {
  const config = siteConfigFrom(loadPublicEnv());
  if (!(config.GITHUB_PUBLIC && githubRepo(config.GITHUB_URL))) {
    throw new Error('releases:sync needs WEB_GITHUB_PUBLIC=true and a github.com WEB_GITHUB_URL.');
  }
  const releases = await loadReleases({
    githubUrl: config.GITHUB_URL,
    githubPublic: true,
    log: (message) => {
      throw new Error(message);
    },
  });
  const source = readFileSync(SNAPSHOT_PATH, 'utf8');
  const head = source.slice(0, source.indexOf('export const snapshotReleases'));
  writeFileSync(SNAPSHOT_PATH, `${head}export const snapshotReleases: Release[] = ${JSON.stringify(releases, null, 2)};\n`);
  console.log(`releases: wrote ${releases.length} release(s) to ${SNAPSHOT_PATH}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await sync();
}
