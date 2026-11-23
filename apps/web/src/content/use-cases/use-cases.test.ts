import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileQuery } from '../../../../../packages/clickhouse/src/query';
import { trailQuery } from '../../../../../packages/sdk/src/read';
import { quietHrefWarnings, renderPages } from '../../test/render-pages';
import { SITE } from '../site';
import { complianceEvidence } from './compliance-evidence';
import { authorize as authorizeSample, customerAuditLogsContent } from './customer-audit-logs';
import { supportInvestigations } from './support-investigations';

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
      const limitAt = text.indexOf('A project read key reads the whole project.');
      expect(limitAt).toBeGreaterThan(-1);
      expect(limitAt).toBeLessThan(text.indexOf('Authorize every read in one place.'));
      // Scoped read access appears, as the last section, exactly when SCOPED_READ_LIVE is on.
      expect(/viewer token/i.test(text), 'scoped section').toBe(SITE.scopedReadLive);
      if (SITE.scopedReadLive)
        expect(text.indexOf('Scoped keys and viewer tokens.')).toBeGreaterThan(text.indexOf('Render it with your own components.'));
      expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);
      expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
      expect(html).toMatch(/<a aria-label="Open the image full size: Customer account"[^>]*href="\/media\/tenant-summary-/);
    }
  }, 60_000);
});

/**
 * Runs the page's Nuxt authorize() sample as written, with the SDK's real trailQuery and a stubbed getSession: a sample
 * that forwarded a query without the tenant term for some session would be the worst example this page could show.
 */
describe('the customer page scoped section', () => {
  it('is the last section when scoped read access is live, and absent before', () => {
    const ids = (scopedReadLive: boolean) => customerAuditLogsContent({ ...SITE, scopedReadLive }).sections.map((section) => section.id);
    expect(ids(true).at(-1)).toBe('scoped');
    expect(ids(false)).not.toContain('scoped');
  });
});

describe('the customer page authorize() sample', () => {
  type Hooks = { authorize: (event: unknown, query: Record<string, unknown>) => Promise<false | { q?: string; cursor?: string }> };
  const load = (session: unknown): Hooks => {
    const body = authorizeSample
      .replace(/^import .*$/gm, '')
      .replace('export default {', 'return {')
      .replace('} satisfies LogbirdHooks;', '};');
    return new Function('trailQuery', 'getSession', body)(trailQuery, async () => session) as Hooks;
  };
  const browser = { q: 'tenant:"someone-else"', cursor: 'next-page', order: 'asc' };

  it('refuses a request without a session, without permission, or without a non-empty tenant id', async () => {
    for (const session of [
      null,
      undefined,
      {},
      { canViewHistory: false, tenantId: 'biz_7' },
      { canViewHistory: true },
      { canViewHistory: true, tenantId: '' },
      { canViewHistory: true, tenantId: '   ' },
      { canViewHistory: true, tenantId: 7 },
    ]) {
      expect(await load(session).authorize({}, browser), JSON.stringify(session)).toBe(false);
    }
  });

  it("forwards only the signed-in account's tenant term, quoted, with the cursor, ignoring the browser's filter", async () => {
    const trusted = await load({ canViewHistory: true, tenantId: 'biz_7' }).authorize({}, browser);
    expect(trusted).toStrictEqual(trailQuery({ tenant: 'biz_7', cursor: 'next-page' }));
    const quoted = await load({ canViewHistory: true, tenantId: 'a" OR tenant:"b' }).authorize({}, {});
    expect(quoted).not.toBe(false);
    const q = (quoted as { q?: string }).q;
    expect(q).toBe(trailQuery({ tenant: 'a" OR tenant:"b' }).q);
    expect(q).not.toBe('tenant:"a" OR tenant:"b"');
  });
});

describe('the support investigations page', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders every section, opens its console crops full size, and makes no unmeasured or assurance claim', async () => {
    quietHrefWarnings();
    const github = { WEB_GITHUB_URL: 'https://github.com/example-org/logbird' };
    for (const env of [{ ...github, WEB_GITHUB_PUBLIC: 'true' }, github, { ...github, WEB_APP_URL: 'https://app.example.test' }]) {
      const [page] = await renderPages(['/use-cases/support-investigations'], env);
      const html = page?.html ?? '';
      const text = plain(html);
      expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);
      expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
      for (const section of supportInvestigations.sections) expect(html).toContain(`id="${section.id}-title"`);
      expect(html).toMatch(/<a aria-label="Open the image full size: Explorer"[^>]*href="\/media\/explorer-/);
      expect(html).toMatch(/<a aria-label="Open the image full size: Event detail"[^>]*href="\/media\/event-detail-/);
      // The count is a lower bound when it is cut short; no speed or size claim the docs don't measure.
      expect(text).toContain('a lower bound');
      expect(text).not.toMatch(/\b(instant(ly)?|real-time|millisecond|tamper\w*|immutable|certified)\b/i);
      // Reads are not in workspace activity: the page says so.
      expect(text).toContain('but not reads');
    }
  }, 60_000);

  it('shows only example queries that the query language accepts, each exactly as shown', () => {
    const points = supportInvestigations.sections.find((section) => section.id === 'search')?.points ?? [];
    // Each example is one inline code span and nothing else, so what a reader copies is the query alone.
    const queries = points.map((point) => /^`([^`]+)`$/.exec(point.body)?.[1] ?? '');
    expect(queries).toHaveLength(4);
    for (const query of queries) {
      expect(query, 'one code span').not.toBe('');
      expect(() => compileQuery(query), query).not.toThrow();
    }
    // The page shows no code block whose copy button would copy several queries at once.
    expect(supportInvestigations.sections.flatMap((section) => section.steps ?? []).filter((step) => step.code)).toEqual([]);
    // The inline attribute example in the closing table compiles too.
    expect(() => compileQuery('metadata.channel:whatsapp')).not.toThrow();
  });
});
