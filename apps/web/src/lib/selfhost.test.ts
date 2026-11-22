import { describe, expect, it } from 'vitest';
import { firstRelease, latestRelease, releases, supportedLine } from './releases';
import { cloneUrl } from './selfhost';

describe('self-host and release facts', () => {
  it('builds one clone URL whether the configured repository URL ends in .git, a slash, or neither', () => {
    for (const url of [
      'https://github.com/example-org/example',
      'https://github.com/example-org/example.git',
      'https://github.com/example-org/example/',
    ]) {
      expect(cloneUrl(url)).toBe('https://github.com/example-org/example.git');
    }
  });

  it('derives the supported line and the first and latest releases from the release list', () => {
    const versions = releases.map((release) => release.version);
    expect(latestRelease && versions).toContain(latestRelease?.version);
    expect(supportedLine).toBe(latestRelease?.version.split('.').slice(0, 2).join('.'));
    expect(firstRelease?.version).toBe([...versions].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))[0]);
  });
});
