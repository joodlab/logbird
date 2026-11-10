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

/**
 * The Allow/Disallow rules of every `User-agent: *` group. A CDN may add its own groups to the served file (Cloudflare's
 * managed content signals prepend `Allow: /` for everyone plus `Disallow: /` for named AI crawlers), so rules for named
 * crawlers must not count. A group is its consecutive User-agent lines and the rules after them (RFC 9309).
 */
export function wildcardRobotsRules(robots: string) {
  const rules: string[] = [];
  let agents: string[] = [];
  let inRules = false;
  for (const raw of robots.split(/\r?\n/)) {
    const [, name, rest] = /^([^:#]+):([^#]*)/.exec(raw.trim()) ?? [];
    if (name === undefined || rest === undefined) continue;
    const field = name.trim().toLowerCase();
    const value = rest.trim();
    if (field === 'user-agent') {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value);
    } else {
      inRules = true;
      if (agents.includes('*') && (field === 'allow' || field === 'disallow')) rules.push(`${field}: ${value}`);
    }
  }
  return rules;
}

/** True when the served robots.txt is the indexable one (discovery.ts): every release blocker is closed. */
export const robotsAllowsCrawling = (robots: string) => {
  const rules = wildcardRobotsRules(robots);
  return rules.includes('allow: /') && !rules.includes('disallow: /');
};

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
