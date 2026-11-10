import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CHANGELOG_PATH, changelogHighlights, githubRepo, loadReleases } from '../../scripts/releases';
import { byVersionDesc, releaseUrl } from './releases';
import { snapshotReleases } from './releases.snapshot';

const changelog = `# Changelog

## Unreleased

## 9.9.0

### Highlights

- Fictional \`code\` highlight one.
- Fictional highlight two.

### Upgrade and known limits

- Not a highlight.

## 9.8.0

Prose without highlights.
`;

const githubRelease = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/example-org/example/releases/tag/${tag}`,
  published_at: '2026-11-08T07:42:48Z',
  draft: false,
  prerelease: false,
  ...extra,
});
const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('release list', () => {
  it('reads only the highlight bullets of the exact version', () => {
    expect(changelogHighlights(changelog, '9.9.0')).toEqual(['Fictional `code` highlight one.', 'Fictional highlight two.']);
    expect(changelogHighlights(changelog, '9.8.0')).toEqual([]);
    expect(changelogHighlights(changelog, '9.9')).toEqual([]);
  });

  it('every snapshot release has its highlights in the real CHANGELOG.md', () => {
    const real = readFileSync(CHANGELOG_PATH, 'utf8');
    for (const release of snapshotReleases) {
      expect(release.highlights).toEqual(changelogHighlights(real, release.version));
      expect(release.highlights.length).toBeGreaterThan(0);
    }
  });

  it('accepts only github.com repository URLs', () => {
    expect(githubRepo('https://github.com/example-org/example')).toBe('example-org/example');
    expect(githubRepo('https://github.com/example-org/example.git')).toBe('example-org/example');
    expect(githubRepo('https://gitlab.com/example-org/example')).toBeUndefined();
    expect(githubRepo(undefined)).toBeUndefined();
  });

  it('lists published stable releases from GitHub with CHANGELOG highlights', async () => {
    const fetchImpl = respond([
      githubRelease('v9.9.0'),
      githubRelease('v9.10.0-rc.1', { prerelease: true }),
      githubRelease('v9.11.0', { draft: true, published_at: null }),
      githubRelease('nightly'),
      githubRelease('v9.8.0'),
    ]);
    const releases = await loadReleases({ githubUrl: 'https://github.com/example-org/example', githubPublic: true, changelog, fetchImpl });
    expect(releases).toEqual([
      { version: '9.9.0', date: '2026-11-08', highlights: ['Fictional `code` highlight one.', 'Fictional highlight two.'] },
      { version: '9.8.0', date: '2026-11-08', highlights: [] },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/repos/example-org/example/releases?per_page=100', expect.anything());
  });

  it('follows pagination so older releases never drop off', async () => {
    const first = 'https://api.github.com/repos/example-org/example/releases?per_page=100';
    const second = 'https://api.github.com/repos/example-org/example/releases?per_page=100&page=2';
    const fetchImpl = vi.fn(async (url: string) =>
      url === first
        ? new Response(JSON.stringify([githubRelease('v9.9.0')]), { headers: { link: `<${second}>; rel="next", <${second}>; rel="last"` } })
        : Response.json([githubRelease('v9.8.0')]),
    ) as unknown as typeof fetch;
    const releases = await loadReleases({ githubUrl: 'https://github.com/example-org/example', githubPublic: true, changelog, fetchImpl });
    expect(releases.map((release) => release.version)).toEqual(['9.9.0', '9.8.0']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to the snapshot when GitHub fails, and never asks GitHub for a private repository', async () => {
    const log = vi.fn();
    const failing = respond({ message: 'rate limited' }, 403);
    const fallback = await loadReleases({
      githubUrl: 'https://github.com/example-org/example',
      githubPublic: true,
      changelog,
      fetchImpl: failing,
      log,
    });
    expect(fallback.map((release) => release.version)).toEqual(snapshotReleases.map((release) => release.version));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('403'));

    const unused = respond([]);
    await loadReleases({ githubUrl: 'https://github.com/example-org/example', githubPublic: false, changelog, fetchImpl: unused });
    expect(unused).not.toHaveBeenCalled();
  });

  it('orders by SemVer and links to the configured repository', () => {
    const versions = ['0.9.0', '0.10.0', '0.10.1'].map((version) => ({ version }));
    expect([...versions].sort(byVersionDesc).map((release) => release.version)).toEqual(['0.10.1', '0.10.0', '0.9.0']);
    expect(releaseUrl('https://github.com/example-org/example', { version: '0.10.1' })).toBe(
      'https://github.com/example-org/example/releases/tag/v0.10.1',
    );
  });
});
