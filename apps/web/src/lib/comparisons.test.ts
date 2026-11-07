import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCESSED, comparisons, longDate } from './comparisons';
import { getPage } from './site-map';

describe('comparisons', () => {
  it.each(comparisons)('$slug cites a listed source for every claim, and lists no unused source', (comparison) => {
    const ids = comparison.sources.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cited = new Set([
      ...comparison.summarySourceIds,
      ...(comparison.note?.sourceIds ?? []),
      ...comparison.rows.flatMap((row) => row.sourceIds),
    ]);
    for (const id of cited) {
      expect(ids).toContain(id);
    }
    expect(ids.filter((id) => !cited.has(id))).toEqual([]);
  });

  it.each(comparisons)('$slug sources are dated and official https links', (comparison) => {
    for (const source of comparison.sources) {
      expect(source.accessed).toBe(ACCESSED);
      for (const url of [source.url, ...(source.also ?? [])]) {
        expect(new URL(url).protocol).toBe('https:');
      }
    }
  });

  it.each(comparisons)('$slug has a manifest page and no performance numbers', (comparison) => {
    expect(getPage(comparison.path).section).toBe('compare');
    const text = JSON.stringify(comparison);
    expect(text).not.toMatch(/\d\s?(ms|milliseconds|events\/s|req\/s|rps)\b/i);
    expect(text.toLowerCase()).not.toContain(['jo', 'od', 'cms'].join(''));
  });

  it('formats the access date without locale data', () => {
    expect(longDate('2026-11-07')).toBe('7 November 2026');
  });
});

describe('trust page metadata', () => {
  it.each(['/cloud', '/open-source', '/security', '/compare', ...comparisons.map((comparison) => comparison.path)])(
    '%s has a real description of at most 155 characters',
    (path) => {
      const { description } = getPage(path);
      expect(description).not.toMatch(/being prepared/);
      expect(description.length).toBeLessThanOrEqual(155);
    },
  );
});

describe('source availability (WEB_GITHUB_PUBLIC)', () => {
  const logbirdCells = (rows: { logbird: string }[]) => rows.map((row) => row.logbird).join('\n');
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it('says the source is not open yet while the repository is private', async () => {
    vi.resetModules();
    const { comparisons: current } = await import('./comparisons');
    const { getPage: page } = await import('./site-map');
    const cells = logbirdCells(current.flatMap((comparison) => comparison.rows));
    expect(cells).toContain('MIT; source opens publicly soon');
    expect(cells).toContain('Self-hosted when the source opens (MIT); Logbird Cloud waitlist');
    expect(cells).not.toMatch(/Self-hosted, MIT;|source on GitHub/);
    expect(page('/open-source').description).toMatch(/opens publicly soon\.$/);
  });
  it('drops every "opens soon" string once the repository is public', async () => {
    vi.resetModules();
    vi.stubEnv('WEB_GITHUB_PUBLIC', 'true');
    vi.stubEnv('WEB_GITHUB_URL', 'https://github.example.test/acme/logbird');
    const { comparisons: current } = await import('./comparisons');
    const { getPage: page, staticPages } = await import('./site-map');
    const { SOURCE_STATE_PHRASES } = await import('./source-state');
    const cells = logbirdCells(current.flatMap((comparison) => comparison.rows));
    expect(cells).not.toMatch(/opens|soon|Planned/);
    const descriptions = staticPages.map((entry) => entry.description).join(' | ');
    for (const phrase of SOURCE_STATE_PHRASES) {
      expect(cells).not.toContain(phrase);
      expect(descriptions).not.toContain(phrase);
    }
    expect(cells).toContain('MIT; source on GitHub');
    expect(cells).toContain('Self-hosted, MIT; Logbird Cloud waitlist');
    expect(page('/open-source').description).toBe(
      'The Logbird product is MIT-licensed: API, console, worker, SDK and integrations, in one repository on GitHub.',
    );
  });
});
