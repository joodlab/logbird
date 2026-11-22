import { describe, expect, it } from 'vitest';
import { siteConfigFrom } from '../env';
import { byPublished, byVersionDesc, type Release } from './releases';
import { cloneUrl } from './selfhost';

const release = (version: string, date: string): Release => ({ version, date, highlights: ['Fictional highlight.'] });

describe('self-host and release facts', () => {
  it('keeps one browser URL for the repository and adds .git only for cloning', () => {
    for (const value of [
      'https://github.com/example-org/example',
      'https://github.com/example-org/example.git',
      'https://github.com/example-org/example/',
    ]) {
      const { GITHUB_URL } = siteConfigFrom({ WEB_GITHUB_URL: value });
      expect(GITHUB_URL, value).toBe('https://github.com/example-org/example');
      expect(cloneUrl(GITHUB_URL as string)).toBe('https://github.com/example-org/example.git');
    }
  });

  it('picks the newest release by version and the first by publication date, whatever the order of the list', () => {
    const list = [release('0.1.1', '2026-11-10'), release('0.2.0', '2026-12-01'), release('0.1.0', '2026-11-09'), release('0.1.3', '2026-11-22')];
    const sorted = [...list].sort(byVersionDesc);
    expect(sorted[0]?.version).toBe('0.2.0');
    // A patch for an older line published later is still not the first release.
    expect([...list, release('0.0.9', '2026-12-05')].sort(byPublished)[0]?.version).toBe('0.1.0');
    expect([].sort(byVersionDesc)[0]).toBeUndefined();
  });
});
