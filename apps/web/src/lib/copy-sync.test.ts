import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { quietHrefWarnings, renderPages } from '../test/render-pages';
import { appearsIn, copyClaims, loose, visible } from './copy-claims';

/**
 * One source per claim: every heading, body, bullet, step and limit line a copy file states for a page must appear on
 * that page as the public build renders it (marketing/copy/README.md maps files to routes). A correction made on one
 * side only fails here. Variants the public build doesn't render, and engineering notes, are marked in the copy with
 * `<!-- copy-sync: skip (reason) -->`.
 */
const COPY_DIR = new URL('../../../../marketing/copy/', import.meta.url);
const copy = (file: string) => readFileSync(fileURLToPath(new URL(file, COPY_DIR)), 'utf8');

/** Copy files with no page to check, and why. Every other file in the README's map must be checked. */
const NOT_CHECKED: Record<string, string> = {
  'blog.md': 'draft post; the blog index has no published entries yet',
  'legal-privacy.md': 'legal wording is owner-approved and pinned by legal-pages.test.ts',
  'legal-terms.md': 'legal wording is owner-approved and pinned by legal-pages.test.ts',
  'arabic-notes.md': 'reference strings, not a page',
};

/** File → route, from the table in marketing/copy/README.md. */
function routeMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of copy('README.md').matchAll(/^\| \[`([^`]+)`\]\([^)]+\) \| [^|]+ \| `([^`]+)`/gm)) {
    const [, file, route] = row;
    if (file && route && !(file in NOT_CHECKED)) {
      map[file] = route === '*' ? '/404' : route;
    }
  }
  return map;
}

const pageText = (html: string) =>
  loose(
    visible(
      html
        .replace(/<script[\s\S]*?<\/script>/g, ' ')
        .replace(/<style[\s\S]*?<\/style>/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/&amp;/g, '&'),
    ),
  );

describe('copy claims', () => {
  it('reads fields, list items, continuation lines and skip markers, and drops comments and citations', () => {
    const claims = copyClaims(
      [
        '## intro',
        '',
        '- **id:** `intro`',
        '- **heading (H1):** One **call** per `action`.',
        '- **body:** First line',
        '  continues here. <!-- source: somewhere --> [S1–S4]',
        '- **visual:** not a claim',
        '- **bullets:**',
        '  - **Batched.** By default, every second.',
        '  - Internal only. <!-- copy-sync: skip (engineering note) -->',
        '  - **Starting size:** 4 vCPU.',
        '  1. A step,',
        '     on two lines [W2, W7].',
        '- **limit line:** A [link](https://example.test) stays as its text.',
      ].join('\n'),
      'example.md',
    );
    expect(claims).toEqual([
      { where: 'example.md#intro', field: 'heading (H1)', text: 'One call per action.' },
      { where: 'example.md#intro', field: 'body', text: 'First line continues here.' },
      { where: 'example.md#intro', field: 'bullets', text: 'Batched. By default, every second.' },
      { where: 'example.md#intro', field: 'bullets', text: 'Starting size: 4 vCPU.' },
      { where: 'example.md#intro', field: 'bullets', text: 'A step, on two lines.' },
      { where: 'example.md#intro', field: 'limit line', text: 'A link stays as its text.' },
    ]);
  });

  it('ignores case, punctuation and markup boundaries, but not words, and fills placeholders with words only', () => {
    const page = loose('Retried Rate limits ( 429 ), server errors… The latest release is 0.1.3, with images.');
    expect(appearsIn('**Retried.** Rate limits (`429`), server errors', page)).toBe(true);
    expect(appearsIn('Retried. Rate limits (430), server errors', page)).toBe(false);
    expect(appearsIn('The latest release is <latest release>, with images.', page)).toBe(true);
    expect(appearsIn('The latest release is <latest release>, without images.', page)).toBe(false);
    // An angle bracket that isn't a placeholder is punctuation.
    expect(appearsIn('job_attempt > 2', loose('job_attempt 2'))).toBe(true);
  });

  it('checks every copy file the README maps to a page', () => {
    const map = routeMap();
    expect(Object.keys(map).length).toBeGreaterThanOrEqual(15);
    for (const file of Object.keys(map)) {
      expect(copyClaims(copy(file), file).length, `${file} yields claims`).toBeGreaterThan(0);
    }
  });

  it('every claim in the copy appears on its page, as the public build renders it', async () => {
    quietHrefWarnings();
    const map = routeMap();
    const pages = await renderPages([...new Set(Object.values(map))], {
      WEB_GITHUB_PUBLIC: 'true',
      WEB_GITHUB_URL: 'https://github.com/example-org/logbird',
    });
    const missing: string[] = [];
    let checked = 0;
    for (const [file, route] of Object.entries(map)) {
      const text = pageText(pages.find((page) => page.path === route)?.html ?? '');
      for (const claim of copyClaims(copy(file), file)) {
        checked += 1;
        if (!appearsIn(claim.text, text)) {
          missing.push(`${claim.where} (${claim.field}): ${claim.text}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(250);
    expect(missing, 'copy claims missing from their pages (fix the page or the copy, so both say the same)').toEqual([]);
  }, 120_000);
});
