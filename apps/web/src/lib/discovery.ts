import { type SiteConfig, siteConfig } from '../env';
import { postPath, posts } from './publications';
import { siteIndexable } from './release';
import { publishedPages } from './site-map';

/** Ready pages plus every published post: what the sitemap and llms.txt list once the site is indexable. */
const listed = () => [
  ...publishedPages,
  ...posts.map((post) => ({ path: postPath(post), title: post.title, description: post.description, changefreq: 'monthly', priority: 0.5 })),
];

// Each function takes the resolved config so the build (vite.config.ts) can pass the same values the bundle uses.
const escapeXml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
export function sitemapXml(config: SiteConfig = siteConfig) {
  const pages = siteIndexable(config) ? listed() : [];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((page) => `<url><loc>${escapeXml(new URL(page.path, config.SITE_URL).href)}</loc><changefreq>${page.changefreq}</changefreq><priority>${page.priority}</priority></url>`).join('')}</urlset>\n`;
}
/** Disallow everything while a release blocker is open (see release.ts). */
export const robotsTxt = (config: SiteConfig = siteConfig) =>
  siteIndexable(config) ? `User-agent: *\nAllow: /\nSitemap: ${config.SITE_URL}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n';
export const llmsTxt = (config: SiteConfig = siteConfig) =>
  `# Logbird\n\n${(siteIndexable(config) ? listed() : []).map((page) => `- [${page.title}](${new URL(page.path, config.SITE_URL).href}): ${page.description}`).join('\n')}\n`;
