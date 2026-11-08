import { postPath, posts } from './publications';
import { publishedPages } from './site-map';

/** The parts of a Lighthouse result (LHR) the pass mark reads. */
export interface LighthouseResult {
  categories: { seo: { score: number | null; auditRefs: { id: string; weight: number }[] } };
  audits: Record<string, { score: number | null } | undefined>;
}

/**
 * The SEO score without the `is-crawlable` audit (`seo-content`): the same weighted mean Lighthouse uses, over every
 * other positively weighted audit that has a score.
 */
export function seoWithoutCrawlable(lhr: LighthouseResult): number {
  const refs = lhr.categories.seo.auditRefs.filter((ref) => ref.weight > 0 && ref.id !== 'is-crawlable' && lhr.audits[ref.id]?.score !== null);
  const weight = refs.reduce((sum, ref) => sum + ref.weight, 0);
  return weight ? Math.round((refs.reduce((sum, ref) => sum + ref.weight * (lhr.audits[ref.id]?.score ?? 0), 0) / weight) * 100) : 0;
}

/** True when the served robots.txt is the indexable one (discovery.ts): every release blocker is closed. */
export const robotsAllowsCrawling = (robots: string) => /^Allow:\s*\/\s*$/m.test(robots) && !/^Disallow:\s*\/\s*$/m.test(robots);

/** Paths that must be crawlable on an indexable site: ready static pages and published posts. */
export const indexedPaths = () => new Set([...publishedPages().map((page) => page.path), ...posts.map(postPath)]);

/**
 * The SEO score a page must reach. While the site is gated (robots.txt disallows everything), every page is noindex by
 * design and the release gate has its own tests, so the mark is `seo-content`. Once the site is indexable, a page that
 * should be indexed is held to the full score, `is-crawlable` included, so an accidental noindex on it fails. Pages that
 * stay noindex (unready pages, 404) keep `seo-content`.
 */
export function seoPassMark(row: { path: string; seo: number; 'seo-content': number }, siteCrawlable: boolean, indexed = indexedPaths()) {
  return siteCrawlable && indexed.has(row.path) ? { key: 'seo', score: row.seo } : { key: 'seo-content', score: row['seo-content'] };
}
