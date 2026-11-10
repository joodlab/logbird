import { type SiteConfig, siteConfig } from '../env';
import { postPath, posts } from './publications';
import { siteIndexable } from './release';
import { publishedPages } from './site-map';

/** Ready pages plus every published post: what the sitemap and llms.txt list once the site is indexable. */
const listed = () => [
  ...publishedPages(),
  ...posts.map((post) => ({ path: postPath(post), title: post.title, description: post.description, changefreq: 'monthly', priority: 0.5 })),
];

// Each function takes the resolved config so the build (vite.config.ts) can pass the same values the bundle uses.
const escapeXml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
export function sitemapXml(config: SiteConfig = siteConfig) {
  const pages = siteIndexable(config) ? listed() : [];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((page) => `<url><loc>${escapeXml(new URL(page.path, config.SITE_URL).href)}</loc><changefreq>${page.changefreq}</changefreq><priority>${page.priority}</priority></url>`).join('')}</urlset>\n`;
}
/**
 * Console and API paths. When the hosted console shares the site's origin (WEB_APP_URL's origin is WEB_SITE_URL's: the
 * console forwards marketing paths to this site, see docs/coolify.md), crawlers stay off everything that isn't the
 * site. Keep in step with the console's routes (apps/app/src/routes) and its proxied API paths.
 */
export const CONSOLE_PATHS = [
  '/api/',
  '/v1/',
  '/docs',
  '/openapi.json',
  '/login',
  '/accept-invitation/',
  '/join/',
  '/onboarding',
  '/account',
  '/p/',
  '/projects',
  '/brand/',
  '/health',
  '/livez',
  '/readyz',
];
const sharesOrigin = (config: SiteConfig) => Boolean(config.APP_URL && new URL(config.APP_URL).origin === new URL(config.SITE_URL).origin);
/** Disallow everything while a release blocker is open (see release.ts). */
export const robotsTxt = (config: SiteConfig = siteConfig) => {
  if (!siteIndexable(config)) {
    return 'User-agent: *\nDisallow: /\n';
  }
  const consolePaths = sharesOrigin(config) ? CONSOLE_PATHS.map((path) => `Disallow: ${path}\n`).join('') : '';
  return `User-agent: *\nAllow: /\n${consolePaths}Sitemap: ${config.SITE_URL}/sitemap.xml\n`;
};
export const llmsTxt = (config: SiteConfig = siteConfig) =>
  `# Logbird\n\n${(siteIndexable(config) ? listed() : []).map((page) => `- [${page.title}](${new URL(page.path, config.SITE_URL).href}): ${page.description}`).join('\n')}\n`;
