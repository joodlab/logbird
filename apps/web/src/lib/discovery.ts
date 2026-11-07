import { SITE_URL } from '../env';
import { staticPages } from './site-map';

const escapeXml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
export function sitemapXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${staticPages.map((page) => `<url><loc>${escapeXml(new URL(page.path, SITE_URL).href)}</loc><changefreq>${page.changefreq}</changefreq><priority>${page.priority}</priority></url>`).join('')}</urlset>\n`;
}
export const robotsTxt = () => `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`;
export const llmsTxt = () =>
  `# Logbird\n\n${staticPages.map((page) => `- [${page.title}](${new URL(page.path, SITE_URL).href}): ${page.description}`).join('\n')}\n`;
