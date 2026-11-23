import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileQuery } from '../../../../packages/clickhouse/src/query';
import { screenshots } from '../lib/media-manifest';
import { renderPages } from '../test/render-pages';
import { evidenceLimits } from './evidence-limits';
import { home } from './home';

/**
 * Design pass 2 (maintainer rulings): the hero shows the real explorer with nothing layered over it, at high fetch
 * priority; its visible query is one the query language accepts; the evidence section shows a real completed export's
 * record with the limit sentence beside it; detailed captures open full size on a phone.
 */
const section = (html: string, id: string) => {
  const start = html.indexOf(`id="${id}"`);
  const next = html.indexOf('<section', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
};

describe('landing visuals', () => {
  it("the hero's visible query compiles, and every capture the landing page names is in the manifest", () => {
    expect(() => compileQuery(home.explorer.query)).not.toThrow();
    const ids = [home.explorer.id, home.customers.screenshot.id, home.evidence.screenshot.id, home.operators.screenshot.id];
    for (const id of ids) expect(screenshots.map((entry) => entry.id)).toContain(id);
    // Each has a real dark capture and a phone-legible form (a phone capture or the full-size link).
    for (const id of ids) expect(screenshots.find((entry) => entry.id === id)?.dark, id).toBeDefined();
  });

  it('renders the hero explorer at high priority with no illustration over it, and the evidence record beside its limit', async () => {
    const [page] = await renderPages(['/']);
    const html = page?.html ?? '';
    const hero = html.slice(html.indexOf('id="hero-title"'), html.indexOf('id="customers"'));
    expect(hero).toMatch(/<img[^>]*fetchPriority="high"[^>]*src="\/media\/explorer-hero-light-/i);
    expect(hero).not.toContain('log-stack');
    expect(hero).toContain(home.hero.sample.title);
    expect(hero.indexOf('explorer-hero')).toBeLessThan(hero.indexOf(home.hero.sample.title));
    expect(hero).toContain('Open the image full size: Explorer');

    const evidence = section(html, 'evidence');
    expect(evidence).toContain('/media/export-record-');
    expect(evidence).not.toContain('/media/retention-');
    expect(evidence.replace(/<[^>]+>/g, '').replaceAll('&#x27;', "'")).toContain(evidenceLimits.exportMatch);
    expect(evidence).toContain('Open the image full size: Workspace activity');

    expect(section(html, 'customers')).toContain('/media/tenant-summary-');
    expect(section(html, 'operators')).toContain('Open the image full size: Event detail');

    // Nothing is positioned over the explorer: the hero's only absolutely positioned element is its background grid.
    expect(hero.match(/class="[^"]*\babsolute\b/g) ?? []).toHaveLength(0);
    expect(html.slice(html.lastIndexOf('<section', html.indexOf('id="hero-title"')), html.indexOf('id="hero-title"'))).toContain(
      'ledger-bg pointer-events-none absolute',
    );
    // The visible variant is switched to eager loading right after the picture is parsed.
    expect(hero).toContain("i.loading='eager'");
  }, 60_000);

  it('a capture that opens full size shows a visible hint beside it, and its link never overrides the theme switch', async () => {
    const [page] = await renderPages(['/']);
    const html = page?.html ?? '';
    // The hint sits in the window bar of each zoomable frame (outside the image): exactly one per zoomable frame, and
    // none on a frame that does not open full size. Frames are counted, not links: a themed frame has two links.
    const frames = [...html.matchAll(/<div class="frame">([\s\S]*?)<\/figure>/g)].map(([, inner]) => inner ?? '');
    const zoomable = frames.filter((frame) => frame.includes('aria-label="Open the image full size: '));
    expect(zoomable.length).toBeGreaterThanOrEqual(4);
    for (const frame of frames) {
      const bar = frame.slice(0, frame.indexOf('class="screenshot"'));
      const hints = (bar.match(/>Full size</g) ?? []).length;
      expect(hints, bar.slice(0, 160)).toBe(zoomable.includes(frame) ? 1 : 0);
    }
    // `.screenshot a` must not set display: it would outrank `.theme-dark { display: none }` and show both themes.
    const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8');
    const rule = /\.screenshot a \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('cursor: zoom-in');
    expect(rule).not.toMatch(/\bdisplay\s*:/);
  }, 60_000);

  it('the capture script shows the same query the page describes and the tests compile', () => {
    const script = readFileSync(fileURLToPath(new URL('../../../app/scripts/capture-media.mjs', import.meta.url)), 'utf8');
    expect(script).toContain(`const heroQuery = '${home.explorer.query}';`);
  });
});
