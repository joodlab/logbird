import { afterEach, describe, expect, it, vi } from 'vitest';
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
  // quietHrefWarnings() spies on console.error; restore it so a second call doesn't wrap the spy in itself.
  afterEach(() => vi.restoreAllMocks());

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
      // The event-detail crop is too small to read on a phone, so it opens full size.
      expect(html).toMatch(/<a aria-label="Open the image full size: Event detail"[^>]*href="\/media\/event-detail-/);
    }
  }, 60_000);

  it('customer audit logs: inside your product, through your backend, with the read-key limit before the how-to', async () => {
    quietHrefWarnings();
    const github = { WEB_GITHUB_URL: 'https://github.com/example-org/logbird' };
    for (const env of [{ ...github, WEB_GITHUB_PUBLIC: 'true' }, github, { ...github, WEB_APP_URL: 'https://app.example.test' }]) {
      const [page] = await renderPages(['/use-cases/customer-audit-logs'], env);
      const html = page?.html ?? '';
      const text = plain(html);
      const hero = plain(html.slice(0, html.indexOf('id="send"')));
      // The first screen says where the history is shown and who decides what each user reads.
      expect(hero).toContain('inside your product, through your own backend');
      // The limit is its own section, before the steps that read and render.
      const limitAt = text.indexOf('A read key reads the whole project.');
      expect(limitAt).toBeGreaterThan(-1);
      expect(limitAt).toBeLessThan(text.indexOf('Authorize every read in one place.'));
      // Scoped read access stays off the page until its production proof is confirmed.
      expect(text).not.toMatch(/viewer token|scoped read|scoped key|\/v1\/viewer-tokens/i);
      expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);
      expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
      expect(html).toMatch(/<a aria-label="Open the image full size: Customer account"[^>]*href="\/media\/tenant-account-/);
    }
  }, 60_000);
});
