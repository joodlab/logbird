import { describe, expect, it } from 'vitest';
import { quietHrefWarnings, renderPages } from '../../test/render-pages';
import { complianceEvidence } from './compliance-evidence';

/** The use-case pages, as they render: the rules the maintainer set for each, and a sound structure for the shared layout. */
const plain = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replace(/\s+/g, ' ');

describe('use-case pages', () => {
  it('compliance evidence keeps both halves of the digest sentence, its units, and no assurance words', async () => {
    quietHrefWarnings();
    const github = { WEB_GITHUB_URL: 'https://github.com/example-org/logbird' };
    for (const env of [{ ...github, WEB_GITHUB_PUBLIC: 'true' }, github, { ...github, WEB_APP_URL: 'https://app.example.test' }]) {
      const [page] = await renderPages(['/use-cases/compliance-evidence'], env);
      const html = page?.html ?? '';
      const text = plain(html);
      // The maintainer's rule: one sentence says what a match shows and that it doesn't show the events were unchanged.
      expect(text).toMatch(/is the file Logbird produced for that export, not that the events were never changed before the export ran/);
      expect(text).toContain('up to 256 changes per event');
      expect(text).toContain('starts right away');
      expect(text).not.toMatch(/\b(integrity|tamper\w*|proof|certified|immediate(ly)?)\b/i);
      expect(text).not.toContain('/v1/export');
      // Structure: one h1, unique ids, every section heading present.
      expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);
      expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
      for (const section of complianceEvidence.sections) expect(html).toContain(`id="${section.id}-title"`);
      // The verification commands substitute the downloaded file once, quoted, and cover macOS.
      expect(text).toContain('shasum -a 256 "$file"');
      expect(text).toContain('Get-FileHash -Algorithm SHA256 $file');
    }
  }, 60_000);
});
