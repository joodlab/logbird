import { afterEach, describe, expect, it, vi } from 'vitest';
import { quietHrefWarnings, renderPages } from '../test/render-pages';
import { type CopyClaim, copyClaims } from './copy-claims';
import { CLOUD_OPEN, copy, copyFiles, NOT_CHECKED, type Page, PLACEHOLDERS, PUBLIC, problems, readPage, routeMap } from './copy-sync';

/** Interim drift check: see the header of copy-sync.ts. Delete this file when the typed content modules land. */
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('copy claims', () => {
  it('classifies every field, binds lists, tables and links, and resolves placeholders', () => {
    const claims = copyClaims(
      [
        '## intro',
        '',
        '- **id:** `intro`',
        '- **heading (H1):** One **call** per `action`.',
        '- **body:** Latest is <latest release>, see <registry>. <!-- source --> [S1–S3]',
        '- **bullets:**',
        '  - **Starting size:** 4 vCPU.',
        '  - Internal. <!-- copy-sync: skip (engineering note) -->',
        '  1. A step,',
        '     on two lines.',
        '- **table:**',
        '  | Field | Value |',
        '  | --- | --- |',
        '  | `id` | 256 [W2, W7] |',
        '- **cta:** Join the waitlist → `/contact` · Quickstart ↓ `#quickstart` (public repo only)',
        '- **body (when Cloud is open):** Request access.',
      ].join('\n'),
      'example.md',
      { 'latest release': '0.2.0' },
    );
    expect(claims.map(({ kind, text, variant, target }) => ({ kind, text, variant, ...(target ? { target } : {}) }))).toEqual([
      { kind: 'heading', text: 'One call per action', variant: 'default' },
      { kind: 'text', text: 'Latest is 0.2.0, see <registry> [S1, S2, S3]', variant: 'default' },
      { kind: 'item', text: 'Starting size 4 vCPU', variant: 'default' },
      { kind: 'item', text: 'A step, on two lines', variant: 'default' },
      { kind: 'row', text: 'Field | Value', variant: 'default' },
      { kind: 'row', text: 'id | 256 [W2, W7]', variant: 'default' },
      { kind: 'link', text: 'Join the waitlist', variant: 'default', target: '/contact' },
      { kind: 'link', text: 'Quickstart', variant: 'default', target: '#quickstart' },
      { kind: 'text', text: 'Request access', variant: 'cloud-open' },
    ]);
    expect(() => copyClaims('## a\n\n- **boddy:** x', 'typo.md')).toThrow(/unknown copy field "boddy"/);
    expect(() => copyClaims('## a\n\n- **body:** x <!-- copy-sync: skip -->', 'bad.md')).toThrow(/copy-sync: skip \(reason\)/);
    expect(() => copyClaims('## a\n\n- **body:** x <!-- copy-sync: skip () -->', 'bad.md')).toThrow(/needs a reason/);
  });

  it('keeps operators, units, signs and case, and binds a claim to whole elements', () => {
    const page = readPage(
      '<main><h2>Releases</h2><p>Two lists: Releases and the build log.</p><p>Retried. Up to <code>5 MB</code>, 10%.</p>' +
        '<ul><li><strong>Batched.</strong> By default, 100.</li><li>Then <code>job_attempt &gt; 2</code>.</li></ul>' +
        '<dl><div><dt>SSO</dt><dd>On the roadmap.</dd></div></dl></main>',
    );
    const check = (markdown: string) => problems(copyClaims(`## s\n\n${markdown}`, 'x.md'), page);
    expect(check('- **body:** Retried. Up to `5 MB`, 10%.')).toEqual([]);
    expect(check('- **body:** Retried. Up to `50 MB`, 10%.')).not.toEqual([]);
    expect(check('- **body:** Retried. Up to `5 MB`, 10.')).not.toEqual([]);
    expect(check('- **body:** retried. Up to `5 MB`, 10%.')).not.toEqual([]);
    expect(check('- **body:** Retried.')).not.toEqual([]); // a prefix isn't the element's text
    expect(check('- **body:** Two lists: Releases and the build log. Daily.')).not.toEqual([]); // nor an extension
    expect(check('- **heading:** Releases')).toEqual([]);
    expect(check('- **heading:** Versions')).not.toEqual([]);
    expect(check('- **heading:** Two lists: Releases and the build log.')).not.toEqual([]); // a paragraph isn't a heading
    expect(check('- **bullets:**\n  - **Batched.** By default, 100.\n  - Then `job_attempt > 2`.')).toEqual([]);
    expect(check('- **bullets:**\n  - **Batched.** By default, 100.\n  - Then `job_attempt < 2`.')).not.toEqual([]);
    expect(check('- **bullets:**\n  - Then `job_attempt > 2`.\n  - **Batched.** By default, 100.')).not.toEqual([]); // order
    expect(check('- **bullets:**\n  - **Batched.** By default, 100.')).not.toEqual([]); // count
    expect(check('- **bullets:**\n  - **SSO.** On the roadmap.')).toEqual([]); // a title and its body in sibling elements
  });

  it('compares composed and decomposed letters and decoded entities alike', () => {
    // The page has a decomposed e-acute (e + U+0301) and entities; the copy has composed letters.
    const acute = String.fromCharCode(0x3_01);
    const page = readPage(`<main><p>Cafe${acute} &amp; d&#xE9;j&#224; vu&nbsp;&#x27;ok&#x27;</p></main>`);
    const body = (text: string) => ['## s', '', `- **body:** ${text}`].join(String.fromCharCode(10));
    expect(
      problems(
        copyClaims(body(`Caf${String.fromCharCode(0xe9)} & d${String.fromCharCode(0xe9)}j${String.fromCharCode(0xe0)} vu 'ok'`), 'x.md'),
        page,
      ),
    ).toEqual([]);
    expect(problems(copyClaims(body("Cafe & deja vu 'ok'"), 'x.md'), page)).not.toEqual([]);
  });

  it('maps every copy file to a page or names why it has none', () => {
    const map = routeMap();
    const files = copyFiles();
    expect(
      files.filter((file) => !(file in map) && !(file in NOT_CHECKED)),
      'copy files neither mapped nor excused',
    ).toEqual([]);
    expect(
      Object.keys(map).filter((file) => !files.includes(file)),
      'mapped files that do not exist',
    ).toEqual([]);
    for (const file of Object.keys(map)) {
      expect(copyClaims(copy(file), file, PLACEHOLDERS).length, `${file} yields claims`).toBeGreaterThan(0);
    }
    for (const [name, value] of Object.entries(PLACEHOLDERS)) expect(value, `placeholder <${name}> has a value`).not.toBe('');
  });

  it('every claim in the copy is on its page, as the public build renders it', async () => {
    quietHrefWarnings();
    const map = routeMap();
    const routes = [...new Set(Object.values(map))];
    const rendered = {
      default: await renderPages(routes, PUBLIC),
      'cloud-open': await renderPages(routes, CLOUD_OPEN),
    };
    const pages = Object.fromEntries(
      Object.entries(rendered).map(([variant, list]) => [variant, Object.fromEntries(list.map(({ path, html }) => [path, readPage(html)]))]),
    ) as Record<CopyClaim['variant'], Record<string, Page>>;
    const found: string[] = [];
    let checked = 0;
    for (const [file, route] of Object.entries(map)) {
      const claims = copyClaims(copy(file), file, PLACEHOLDERS);
      checked += claims.length;
      for (const variant of ['default', 'cloud-open'] as const) {
        const page = pages[variant][route];
        if (!page) throw new Error(`${route} did not render`);
        found.push(
          ...problems(
            claims.filter((claim) => claim.variant === variant),
            page,
          ),
        );
        // And the other way round: each section heading on the page is a heading in the copy, so a section missing from
        // the copy fails too.
        const named = new Set(
          claims.filter((claim) => claim.kind === 'heading' && (claim.variant === variant || claim.variant === 'default')).map((claim) => claim.text),
        );
        for (const heading of page.sections) {
          if (!named.has(heading)) found.push(`${file}: the page (${variant}) has the section heading "${heading}", the copy doesn't`);
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(found, 'copy claims that differ from their pages (change the page and the copy together)').toEqual([]);
  }, 180_000);
});
