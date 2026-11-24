import { COPYRIGHT_HOLDER } from '../env';
import { SITE, type SiteState } from './site';

/**
 * Words of the shell every page shares: the skip link (routes/__root.tsx), the header and the footer
 * (components/site-shell.tsx). The calls to action, the repository link and the footer's tagline are in shared.ts; the
 * nav and footer link labels are the pages' titles in lib/site-map.ts. Brief: marketing/copy/README.md.
 */
export function shellContent(site: SiteState) {
  return {
    skipLink: 'Skip to content',
    header: {
      /** The wordmark link's accessible name. */
      homeLabel: 'Logbird home',
      primaryNavLabel: 'Primary',
      mobileNavLabel: 'Mobile',
      signIn: 'Sign in',
      /** The mobile menu button's accessible name. */
      menuLabel: 'Menu',
      /** The theme switch: its legend (screen readers), each button's name, and the mobile menu's visible label. */
      themeLegend: 'Color theme',
      themeLabel: 'Theme',
      themes: { light: 'Light theme', dark: 'Dark theme', system: 'System theme' },
    },
    footer: {
      /** Read after the wordmark image, for screen readers. */
      brandName: 'Logbird',
      brandLine: 'Retrace every step.',
      /** The headings of the footer's link groups. */
      groups: { product: 'Product', developers: 'Developers', compare: 'Compare', resources: 'Resources', company: 'Company' },
      /** WEB_ORG_NAME names the holder once the owner approves it; "Logbird contributors" until then (env.ts). */
      copyright: { before: '© 2026 ', holder: COPYRIGHT_HOLDER, after: '. Logbird is MIT-licensed.' },
      /** A link while the repository is public, a plain line until then. */
      source: site.githubUrl ? { label: 'Source on GitHub', href: site.githubUrl } : { pending: 'Source on GitHub — coming soon.' },
    },
  };
}

export const shell = shellContent(SITE);
