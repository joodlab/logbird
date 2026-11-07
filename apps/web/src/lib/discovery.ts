import { SITE_URL } from '../env';
import { siteIndexable } from './release';
import { publishedPages } from './site-map';

const escapeXml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
export function sitemapXml() {
  const pages = siteIndexable() ? publishedPages : [];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((page) => `<url><loc>${escapeXml(new URL(page.path, SITE_URL).href)}</loc><changefreq>${page.changefreq}</changefreq><priority>${page.priority}</priority></url>`).join('')}</urlset>\n`;
}
/** Disallow everything while a release blocker is open (see release.ts). */
export const robotsTxt = () => (siteIndexable() ? `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n');
export const llmsTxt = () =>
  `# Logbird\n\n${(siteIndexable() ? publishedPages : []).map((page) => `- [${page.title}](${new URL(page.path, SITE_URL).href}): ${page.description}`).join('\n')}\n`;
