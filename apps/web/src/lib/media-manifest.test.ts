import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { clips, screenshots } from './media-manifest';

it('ships actual media bytes for every manifest source in a clean checkout', () => {
  const paths = screenshots.flatMap((entry) => [entry.light, entry.dark, entry.phone?.light, entry.phone?.dark]);
  for (const path of [...paths, ...clips.flatMap((clip) => [clip.src, clip.poster])].filter((path): path is string => Boolean(path))) {
    const bytes = readFileSync(resolve('../..', path));
    expect(bytes.subarray(0, 100).toString()).not.toContain('git-lfs.github.com/spec');
    if (path.endsWith('.webp')) {
      expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString()).toBe('WEBP');
    } else {
      expect(bytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    }
  }
});

it('keeps the README animation renderable at 1200 px within the 6 MB budget', () => {
  const path = resolve('../../docs/media/walkthrough.gif');
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 6).toString()).toBe('GIF89a');
  expect(bytes.readUInt16LE(6)).toBe(1200);
  expect(statSync(path).size).toBeLessThanOrEqual(6_000_000);
});
