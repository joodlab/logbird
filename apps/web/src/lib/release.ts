import { type SiteConfig, siteConfig } from '../env';
import { interimMedia } from './media-manifest';
import { getPage, type SitePage } from './site-map';

/**
 * Release gate. While any blocker is open the whole site is noindex, robots.txt disallows everything, and
 * `build:cloudflare` refuses to package unless LOGBIRD_WEB_ALLOW_INTERIM=1 (local previews only).
 *
 * - interim media: a console capture may still show a real workspace, a person or a timing;
 * - provisional domain: WEB_SITE_URL is unset, so canonicals point at a domain that isn't ours yet;
 * - security contact: WEB_SECURITY_EMAIL is unset, so the site can't name a vulnerability-report mailbox;
 * - contact mailbox: WEB_CONTACT_EMAIL is unset, so the site can't name a general address;
 * - legal placeholder: /legal/privacy or /legal/terms isn't ready, so the site would collect emails without a published
 *   privacy policy and terms (they stay placeholders until counsel-reviewed text replaces them).
 *
 * No mailbox is ever derived from the provisional domain.
 */
export const LEGAL_PAGES = ['/legal/privacy', '/legal/terms'] as const;
export function releaseBlockers(config: SiteConfig = siteConfig): string[] {
  return [
    ...interimMedia().map((id) => `interim media: ${id}`),
    ...(config.SITE_URL_CONFIGURED ? [] : ['provisional domain: set WEB_SITE_URL']),
    ...(config.SECURITY_EMAIL ? [] : ['security contact: set WEB_SECURITY_EMAIL']),
    ...(config.CONTACT_EMAIL ? [] : ['contact mailbox: set WEB_CONTACT_EMAIL']),
    ...LEGAL_PAGES.filter((path) => !getPage(path).ready).map((path) => `legal placeholder: ${path} needs counsel-reviewed text`),
  ];
}
export const siteIndexable = (config: SiteConfig = siteConfig) => releaseBlockers(config).length === 0;
export const pageIndexable = (page: Pick<SitePage, 'ready' | 'path'>, config: SiteConfig = siteConfig) =>
  siteIndexable(config) && page.ready && !page.path.includes('$');
