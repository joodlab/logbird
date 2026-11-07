import { interimMedia } from './media-manifest';
import type { SitePage } from './site-map';

/**
 * Release gate. While any console capture is still interim (it may show a real workspace, a person or a timing), the
 * whole site is noindex and robots.txt disallows everything, and `build:cloudflare` refuses to package unless
 * LOGBIRD_WEB_ALLOW_INTERIM=1 is set for a local preview (scripts/build-cloudflare.ts).
 */
export const releaseBlockers = (): string[] => interimMedia().map((id) => `interim media: ${id}`);
export const siteIndexable = () => releaseBlockers().length === 0;
export const pageIndexable = (page: Pick<SitePage, 'ready' | 'path'>) => siteIndexable() && page.ready && !page.path.includes('$');
