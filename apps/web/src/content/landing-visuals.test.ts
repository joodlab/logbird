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

    expect(section(html, 'customers')).toContain('/media/tenant-account-');
    expect(section(html, 'operators')).toContain('Open the image full size: Event detail');
  }, 60_000);
});
